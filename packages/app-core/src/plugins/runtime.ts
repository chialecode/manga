import { MangaError, type PluginPermission } from "@manga/contracts";

/**
 * Running the plugins that are installed, trusted and enabled, each in a process of its own (PLUG-04, Q-06). A process is a fault boundary, not a
 * sandbox: it can crash, hang or flood without taking the application with it, but it is not confined by the operating system. So the host
 * does two things only: it starts nothing that is not trusted (the caller checks), and it answers a plugin's requests of the host through a
 * door that checks the permission the person confirmed for that request. Everything else the process does is the publisher's responsibility.
 */

/** One running plugin as the runtime sees it: messages in and out, its end, and a way to stop it. */
export interface PluginChannel {
  readonly pid?: number;
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  /** The last of what the process wrote to its error output, for the failure message. */
  stderrTail?(): string;
}
export type PluginSpawnSpec = { pluginId: string; entry: string; cwd: string; env: Record<string, string> };
export type PluginSpawner = (spec: PluginSpawnSpec) => PluginChannel;

export type PluginRunState = "stopped" | "starting" | "running" | "failed";
export type PluginRunInfo = { state: PluginRunState; error: string | null; pid: number | null; startedAt: string | null; restarts: number };

export type RuntimeLimits = {
  /** How long a plugin has to say it is ready after it starts. */
  readyMs: number;
  /** How often a running plugin is asked whether it is still there, and how many missed answers are tolerated. */
  pingMs: number;
  missedPings: number;
  /** How long a plugin gets to stop when asked, before it is ended. */
  graceMs: number;
  /** The longest a call waits for its answer unless the caller says otherwise. */
  callMs: number;
  /** The most a plugin may send in one second, and the largest single message. Past either, it is ended. */
  messagesPerSecond: number;
  messageBytes: number;
  /** A plugin that ends by itself is started again, up to this many times within the window. */
  maxRestarts: number;
  restartWindowMs: number;
  restartBaseMs: number;
};
export const DEFAULT_LIMITS: RuntimeLimits = {
  readyMs: 10_000, pingMs: 5_000, missedPings: 3, graceMs: 3_000, callMs: 30_000, messagesPerSecond: 5_000, messageBytes: 4 * 1024 * 1024,
  maxRestarts: 3, restartWindowMs: 300_000, restartBaseMs: 500,
};

export type PluginStartSpec = { pluginId: string; entry: string; cwd: string; dataDir: string; granted: readonly PluginPermission[]; env?: Record<string, string> };
export type HostMethod = (params: unknown, caller: { pluginId: string }) => unknown | Promise<unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; abort?: () => void; signal?: AbortSignal };

type Running = {
  spec: PluginStartSpec;
  channel: PluginChannel;
  state: PluginRunState;
  error: string | null;
  startedAt: string | null;
  restarts: number[];
  pending: Map<number, Pending>;
  nextId: number;
  lastPong: number;
  window: { at: number; count: number };
  ready: { resolve: () => void; reject: (error: Error) => void } | null;
  readyPromise: Promise<void>;
  pingTimer: NodeJS.Timeout | null;
  stopping: boolean;
  /** Ends when the process is gone, however it went. */
  exited: Promise<void>;
  markExited: () => void;
};

const failure = (code: "INTERRUPTED" | "PROVIDER_UNAVAILABLE" | "FORBIDDEN" | "CANCELLED", message: string, details: Record<string, unknown> = {}) => new MangaError(code, message, { details });

export class PluginRuntime {
  private readonly spawner: PluginSpawner;
  private readonly limits: RuntimeLimits;
  private readonly running = new Map<string, Running>();
  private readonly failed = new Map<string, string>();
  private readonly hostMethods = new Map<string, { permission: PluginPermission | null; handler: HostMethod }>();
  private readonly eventListeners = new Set<(pluginId: string, name: string, payload: unknown) => void>();
  private readonly stateListeners = new Set<(pluginId: string, info: PluginRunInfo) => void>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(options: { spawn: PluginSpawner; limits?: Partial<RuntimeLimits> }) {
    this.spawner = options.spawn;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.hostMethods.set("log", { permission: null, handler: () => ({}) });
  }

  /** What the host does when a plugin asks. `permission` is what the person must have confirmed for the plugin to be answered; null for a request that needs none. */
  registerHostMethod(name: string, permission: PluginPermission | null, handler: HostMethod): () => void {
    this.hostMethods.set(name, { permission, handler });
    return () => { this.hostMethods.delete(name); };
  }

  onEvent(listener: (pluginId: string, name: string, payload: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  onState(listener: (pluginId: string, info: PluginRunInfo) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  info(pluginId: string): PluginRunInfo {
    const run = this.running.get(pluginId);
    if (run) return { state: run.state, error: run.error, pid: run.channel.pid ?? null, startedAt: run.startedAt, restarts: run.restarts.length };
    const error = this.failed.get(pluginId);
    return { state: error ? "failed" : "stopped", error: error ?? null, pid: null, startedAt: null, restarts: 0 };
  }

  isRunning(pluginId: string): boolean {
    return this.running.get(pluginId)?.state === "running";
  }

  private publish(pluginId: string): void {
    const info = this.info(pluginId);
    for (const listener of this.stateListeners) { try { listener(pluginId, info); } catch { /* a listener's failure is not the plugin's */ } }
  }

  // ---------------------------------------------------------------------------------------------------------- start / stop

  /** Starts the plugin's process and waits until it says it is ready. A plugin that does not start leaves nothing running. */
  async start(spec: PluginStartSpec): Promise<void> {
    if (this.closed) throw failure("INTERRUPTED", "the application is closing");
    const current = this.running.get(spec.pluginId);
    if (current && (current.state === "running" || current.state === "starting")) return current.readyPromise;
    this.clearRestart(spec.pluginId);
    this.failed.delete(spec.pluginId);
    await this.launch(spec, []);
  }

  private async launch(spec: PluginStartSpec, restarts: number[]): Promise<void> {
    const channel = this.spawner({ pluginId: spec.pluginId, entry: spec.entry, cwd: spec.cwd, env: { ...spec.env, MANGA_PLUGIN_ID: spec.pluginId, MANGA_PLUGIN_DATA: spec.dataDir } });
    let markExited = () => undefined as void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    const run: Running = {
      spec, channel, state: "starting", error: null, startedAt: null, restarts, pending: new Map(), nextId: 1, lastPong: Date.now(),
      window: { at: Date.now(), count: 0 }, ready: null, readyPromise: Promise.resolve(), pingTimer: null, stopping: false, exited, markExited,
    };
    this.running.set(spec.pluginId, run);
    this.publish(spec.pluginId);
    const ready = new Promise<void>((resolve, reject) => { run.ready = { resolve, reject }; });
    ready.catch(() => undefined);
    run.readyPromise = ready;
    const readyTimer = setTimeout(() => this.end(run, "the plugin did not say it was ready in time", "starting"), this.limits.readyMs);
    channel.onMessage((message) => this.receive(run, message));
    channel.onExit((code, signal) => this.exit(run, code, signal));
    try {
      channel.send({ t: "init", pluginId: spec.pluginId, dataDir: spec.dataDir, granted: [...spec.granted], hostApi: 1 });
      await ready;
    } finally { clearTimeout(readyTimer); }
  }

  /** Asks the plugin to stop, and ends it when it does not. Resolves when the process is gone. */
  async stop(pluginId: string): Promise<void> {
    this.clearRestart(pluginId);
    const run = this.running.get(pluginId);
    this.failed.delete(pluginId);
    if (!run) { this.publish(pluginId); return; }
    run.stopping = true;
    try { run.channel.send({ t: "stop" }); } catch { /* it is already going */ }
    const grace = setTimeout(() => { try { run.channel.kill(); } catch { /* already gone */ } }, this.limits.graceMs);
    try { await run.exited; } finally { clearTimeout(grace); }
    this.publish(pluginId);
  }

  private clearRestart(pluginId: string): void {
    const timer = this.restartTimers.get(pluginId);
    if (timer) { clearTimeout(timer); this.restartTimers.delete(pluginId); }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const id of [...this.restartTimers.keys()]) this.clearRestart(id);
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  /** Stops every plugin that is running and every restart that is waiting, and stays open: used when the plugin feature is switched off. */
  async stopAll(): Promise<void> {
    for (const id of [...this.restartTimers.keys()]) this.clearRestart(id);
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  /** Ends every plugin's process at once, without waiting: used when the application closes, where nothing can be waited for. */
  killAll(): void {
    this.closed = true;
    for (const id of [...this.restartTimers.keys()]) this.clearRestart(id);
    for (const run of this.running.values()) {
      run.stopping = true;
      try { run.channel.kill(); } catch { /* already gone */ }
    }
  }

  /** Ends a plugin that cannot be left running: it did not start, did not answer, or sent too much. */
  private end(run: Running, reason: string, was: PluginRunState): void {
    if (run.stopping) return;
    run.error = reason;
    this.failed.set(run.spec.pluginId, reason);
    try { run.channel.kill(); } catch { /* already gone */ }
  }

  private exit(run: Running, code: number | null, signal: string | null): void {
    if (run.state === "stopped") return;
    if (run.pingTimer) clearInterval(run.pingTimer);
    run.markExited();
    const wasState = run.state;
    const planned = run.stopping;
    const tail = run.channel.stderrTail?.() ?? "";
    const reason = run.error ?? (planned ? null : `the plugin ended by itself (${signal ?? `code ${code}`})${tail ? `: ${tail.slice(-300)}` : ""}`);
    if (this.running.get(run.spec.pluginId) === run) this.running.delete(run.spec.pluginId);
    for (const [, pending] of run.pending) { clearTimeout(pending.timer); pending.abort?.(); pending.reject(failure("INTERRUPTED", "the plugin stopped before it answered")); }
    run.pending.clear();
    run.state = "stopped";
    if (wasState === "starting") { run.ready?.reject(failure("PROVIDER_UNAVAILABLE", reason ?? "the plugin stopped while starting", { reason: "start" })); run.ready = null; }
    if (planned && !run.error) { this.failed.delete(run.spec.pluginId); this.publish(run.spec.pluginId); return; }
    this.failed.set(run.spec.pluginId, reason ?? "the plugin stopped");
    this.publish(run.spec.pluginId);
    if (wasState === "running" && !this.closed) this.scheduleRestart(run.spec, run.restarts);
  }

  /** A plugin that was running and ended by itself or was ended for misbehaving is started again, a few times with a growing wait, then left stopped with the reason. */
  private scheduleRestart(spec: PluginStartSpec, history: number[]): void {
    const now = Date.now();
    const recent = history.filter((at) => now - at < this.limits.restartWindowMs);
    if (recent.length >= this.limits.maxRestarts) {
      this.failed.set(spec.pluginId, `${this.failed.get(spec.pluginId) ?? "the plugin stopped"}; it was started again ${recent.length} times and is left stopped`);
      this.publish(spec.pluginId);
      return;
    }
    this.clearRestart(spec.pluginId);
    const timer = setTimeout(() => {
      this.restartTimers.delete(spec.pluginId);
      if (this.closed || this.running.has(spec.pluginId)) return;
      const next = [...recent, Date.now()];
      this.launch(spec, next).catch(() => this.scheduleRestart(spec, next));
    }, this.limits.restartBaseMs * 2 ** recent.length);
    timer.unref?.();
    this.restartTimers.set(spec.pluginId, timer);
  }

  // -------------------------------------------------------------------------------------------------------- messages in

  private receive(run: Running, message: unknown): void {
    if (this.running.get(run.spec.pluginId) !== run) return;
    const now = Date.now();
    if (now - run.window.at >= 1000) run.window = { at: now, count: 0 };
    run.window.count += 1;
    if (run.window.count > this.limits.messagesPerSecond) { this.end(run, "the plugin sent more messages than it may", run.state); return; }
    if (!message || typeof message !== "object") return;
    const body = message as { t?: unknown; id?: unknown; method?: unknown; params?: unknown; name?: unknown; payload?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    let size = 0;
    try { size = JSON.stringify(message).length; } catch { size = Infinity; }
    if (size > this.limits.messageBytes) { this.end(run, "the plugin sent a message that is too large", run.state); return; }
    switch (body.t) {
      case "ready":
        run.state = "running";
        run.startedAt = new Date().toISOString();
        run.lastPong = Date.now();
        run.pingTimer = setInterval(() => this.ping(run), this.limits.pingMs);
        run.pingTimer.unref?.();
        run.ready?.resolve();
        run.ready = null;
        this.publish(run.spec.pluginId);
        break;
      case "pong": run.lastPong = Date.now(); break;
      case "result": {
        const pending = typeof body.id === "number" ? run.pending.get(body.id) : undefined;
        if (!pending) break;
        run.pending.delete(body.id as number);
        clearTimeout(pending.timer);
        pending.abort?.();
        if (body.ok === true) pending.resolve(body.value);
        else {
          const error = (body.error ?? {}) as { message?: unknown; code?: unknown };
          pending.reject(new MangaError("PROVIDER_UNAVAILABLE", typeof error.message === "string" ? error.message.slice(0, 500) : "the plugin could not do that", { details: { reason: "plugin", pluginCode: typeof error.code === "string" ? error.code.slice(0, 80) : undefined } }));
        }
        break;
      }
      case "event":
        if (typeof body.name === "string" && body.name.length <= 80) for (const listener of this.eventListeners) { try { listener(run.spec.pluginId, body.name, body.payload); } catch { /* the listener's failure is not the plugin's */ } }
        break;
      case "host": void this.answerHost(run, body.id, body.method, body.params); break;
      default: break;
    }
  }

  private ping(run: Running): void {
    if (Date.now() - run.lastPong > this.limits.pingMs * this.limits.missedPings) { this.end(run, "the plugin stopped answering", run.state); return; }
    try { run.channel.send({ t: "ping", id: run.nextId++ }); } catch { /* the exit handler reports it */ }
  }

  /** A request of the host from a plugin: only a known method, only with the permission the person confirmed. */
  private async answerHost(run: Running, id: unknown, method: unknown, params: unknown): Promise<void> {
    if (typeof id !== "number") return;
    const reply = (ok: boolean, value?: unknown, error?: { code: string; message: string }) => { try { run.channel.send({ t: "reply", id, ok, ...(ok ? { value } : { error }) }); } catch { /* the plugin is gone */ } };
    const entry = typeof method === "string" ? this.hostMethods.get(method) : undefined;
    if (!entry) { reply(false, undefined, { code: "UNKNOWN_METHOD", message: "the host has no such method" }); return; }
    if (entry.permission && !run.spec.granted.includes(entry.permission)) { reply(false, undefined, { code: "PERMISSION_DENIED", message: `the plugin was not given the ${entry.permission} permission` }); return; }
    try { reply(true, await entry.handler(params, { pluginId: run.spec.pluginId })); } catch (error) {
      reply(false, undefined, { code: error instanceof MangaError ? error.code : "FAILED", message: (error instanceof Error ? error.message : "the host could not do that").slice(0, 500) });
    }
  }

  // ------------------------------------------------------------------------------------------------------------- calls

  /** Asks a running plugin to do something and waits for the answer. */
  call(pluginId: string, method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const run = this.running.get(pluginId);
    if (!run || run.state !== "running") return Promise.reject(failure("PROVIDER_UNAVAILABLE", "the plugin is not running", { reason: "not-running" }));
    const id = run.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { run.pending.delete(id); reject(failure("INTERRUPTED", "the plugin did not answer in time", { reason: "timeout" })); }, options.timeoutMs ?? this.limits.callMs);
      const pending: Pending = { resolve, reject, timer };
      if (options.signal) {
        const onAbort = () => { run.pending.delete(id); clearTimeout(timer); reject(failure("CANCELLED", "the call was cancelled")); };
        if (options.signal.aborted) { clearTimeout(timer); reject(failure("CANCELLED", "the call was cancelled")); return; }
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.abort = () => options.signal!.removeEventListener("abort", onAbort);
      }
      run.pending.set(id, pending);
      try { run.channel.send({ t: "call", id, method, params }); } catch (error) {
        run.pending.delete(id);
        clearTimeout(timer);
        pending.abort?.();
        reject(failure("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "the plugin could not be reached", { reason: "send" }));
      }
    });
  }
}
