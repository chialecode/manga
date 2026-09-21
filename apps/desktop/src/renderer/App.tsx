import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Tabs from "@radix-ui/react-tabs";
import { Bot, FolderSearch, Settings, Sidebar } from "lucide-react";
import { createTranslator, type Locale } from "@manga/i18n";

type CommandResult = { status: "ok" | "error"; value?: Record<string, unknown>; error?: { code: string; message: string } };

declare global {
  interface Window {
    manga: {
      command(payload: unknown): Promise<CommandResult>;
      state(): Promise<{ layout: { channel: string; pointerPath: string; partitions: Record<string, string>; writable: boolean; recovery: string }; writable: boolean; vaultAvailable: boolean }>;
      chooseDirectory(): Promise<string | null>;
      chooseFile(): Promise<CommandResult | null>;
      chooseAudio(): Promise<string | null>;
      stashSecret(value: string): Promise<string | null>;
      reveal(id: string): Promise<CommandResult>;
    };
  }
}

const id = () => crypto.randomUUID();

type ConnectionForm = {
  id?: string;
  label: string;
  protocol: string;
  runtime: string;
  baseUrl: string;
  modelId: string;
  purpose: string;
  timeoutMs: string;
  secret: string;
};

const emptyForm = (): ConnectionForm => ({
  label: "本地",
  protocol: "openai-chat-completions",
  runtime: "native",
  baseUrl: "http://127.0.0.1:0",
  modelId: "local-test",
  purpose: "text",
  timeoutMs: "60000",
  secret: "",
});

export function App() {
  const [locale] = useState<Locale>("zh-CN");
  const i18n = useMemo(() => createTranslator(locale), [locale]);
  const [host, setHost] = useState<Awaited<ReturnType<Window["manga"]["state"]>> | null>(null);
  const [workspace, setWorkspace] = useState<Record<string, unknown> | null>(null);
  const [page, setPage] = useState("agent");
  const [sessionId, setSessionId] = useState<string>();
  const [run, setRun] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string>();
  const [inventory, setInventory] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [materials, setMaterials] = useState<string[]>([]);
  const [migration, setMigration] = useState<{ handle: string; checkpointId: string; copies: Array<{ partition: string; bytes: number; target: string }> } | null>(null);
  const [notice, setNotice] = useState<string>();

  async function refresh(nextSession?: string) {
    const state = await window.manga.state();
    setHost(state);
    const ws = await window.manga.command({ commandId: "workspace.get", idempotencyKey: id(), input: {} });
    if (ws.status === "ok") {
      setWorkspace(ws.value ?? {});
      const sessions = (ws.value?.sessions as Array<{ id: string }> | undefined) ?? [];
      const runs = (ws.value?.runs as Array<{ id: string; sessionId: string; status: string }> | undefined) ?? [];
      const sid = nextSession ?? sessionId ?? sessions[0]?.id;
      if (sid && sid !== sessionId) setSessionId(sid);
      if (sid) {
        const sessionRuns = runs.filter((entry) => entry.sessionId === sid);
        const active = sessionRuns.find((entry) => ["queued", "running", "waiting_input", "interrupted"].includes(entry.status)) ?? sessionRuns[0];
        if (active) {
          const runResult = await window.manga.command({ commandId: "agent.getRun", idempotencyKey: id(), input: { runId: active.id } });
          if (runResult.status === "ok") setRun(runResult.value ?? {});
        }
      }
    }
    const inv = await window.manga.command({ commandId: "inventory.overview", idempotencyKey: id(), input: {} });
    if (inv.status === "ok") setInventory(inv.value ?? {});
    const st = await window.manga.command({ commandId: "settings.get", idempotencyKey: id(), input: {} });
    if (st.status === "ok") setSettings(st.value ?? {});
  }

  useEffect(() => {
    void refresh().catch((item) => setError(String(item)));
  }, []);

  useEffect(() => {
    const runId = String(run?.runId ?? run?.id ?? "");
    const status = String(run?.status ?? "");
    if (!runId || !["queued", "running", "waiting_input"].includes(status)) return;
    let cancelled = false;
    const tick = async () => {
      const result = await window.manga.command({ commandId: "agent.getRun", idempotencyKey: id(), input: { runId } });
      if (cancelled) return;
      if (result.status === "ok") setRun(result.value ?? {});
    };
    const timer = window.setInterval(() => { void tick(); }, 400);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [run?.runId, run?.id, run?.status]);

  async function ensureSession() {
    if (sessionId) return sessionId;
    const created = await window.manga.command({ commandId: "agent.createSession", idempotencyKey: id(), input: { title: i18n.t("agent.session", { id: "1" }) } });
    const next = String(created.value?.id ?? "");
    setSessionId(next);
    return next;
  }

  async function send() {
    if (composing || !draft.trim()) return;
    const sid = await ensureSession();
    const result = await window.manga.command({ commandId: "agent.send", idempotencyKey: id(), input: { sessionId: sid, text: draft, readResourceIds: materials } });
    if (result.status === "error") setError(result.error?.message);
    else {
      setRun(result.value ?? {});
      setDraft("");
      setError(undefined);
    }
    await refresh();
  }

  async function retry() {
    const runId = String(run?.runId ?? "");
    if (!runId) return;
    const result = await window.manga.command({ commandId: "agent.retry", idempotencyKey: id(), input: { runId } });
    if (result.status === "error") setError(result.error?.message);
    else setRun(result.value ?? {});
    await refresh();
  }

  async function stop() {
    const runId = String(run?.runId ?? "");
    if (!runId) return;
    await window.manga.command({ commandId: "agent.cancel", idempotencyKey: id(), input: { runId } });
    const latest = await window.manga.command({ commandId: "agent.getRun", idempotencyKey: id(), input: { runId } });
    if (latest.status === "ok") setRun(latest.value ?? {});
  }

  async function chooseLocation() {
    const handle = await window.manga.chooseDirectory();
    if (!handle) return;
    const proposed = await window.manga.command({ commandId: "settings.proposeLocations", idempotencyKey: id(), input: { pathHandle: handle } });
    if (proposed.status === "error") {
      setError(proposed.error?.message);
      return;
    }
    const copies = (proposed.value?.copies as Array<{ partition: string; bytes: number; target: string }> | undefined) ?? [];
    setError(undefined);
    setMigration({ handle, checkpointId: String(proposed.value?.checkpointId ?? ""), copies });
  }

  async function applyMigration() {
    if (!migration) return;
    const applied = await window.manga.command({
      commandId: "settings.applyLocations",
      idempotencyKey: id(),
      input: { checkpointId: migration.checkpointId, pathHandle: migration.handle },
    });
    if (applied.status === "error") setError(applied.error?.message);
    else {
      setError(undefined);
      setNotice(i18n.t("settings.migrationDone"));
    }
    setMigration(null);
    await refresh();
  }

  async function rollbackRecovery() {
    const result = await window.manga.command({ commandId: "settings.recoverJobs", idempotencyKey: id(), input: { action: "rollback" } });
    if (result.status === "error") setError(result.error?.message);
    await refresh();
  }

  async function saveConnection(fields: ConnectionForm) {
    const credentialHandle = fields.secret ? await window.manga.stashSecret(fields.secret) : undefined;
    const result = await window.manga.command({
      commandId: "connections.upsert",
      idempotencyKey: id(),
      input: {
        id: fields.id,
        label: fields.label,
        protocol: fields.protocol,
        runtime: fields.runtime,
        baseUrl: fields.baseUrl,
        modelId: fields.modelId,
        purpose: fields.purpose,
        timeoutMs: Number(fields.timeoutMs) || 60_000,
        credentialHandle,
      },
    });
    if (result.status === "error") {
      setError(result.error?.message);
      return;
    }
    setError(undefined);
    setNotice(i18n.t("settings.connectionSaved"));
    await refresh();
  }

  if (!host) {
    return <main className="p-6">{i18n.t("status.loading")}</main>;
  }
  if (!host.writable) {
    return (
      <main className="p-8 max-w-xl">
        <h1 className="text-xl mb-2">{i18n.t("setup.title")}</h1>
        <p className="text-[var(--color-subtle)] mb-4">{i18n.t("status.offline")}</p>
        <button className="bg-[var(--color-accent)] text-white px-3 py-2 rounded" onClick={() => void window.manga.chooseDirectory()}>{i18n.t("setup.continue")}</button>
      </main>
    );
  }

  const setupNeeded = settings?.needsSetup === true;
  const restartRequired = settings?.restartRequired === true || workspace?.restartRequired === true;
  const resources = (workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? [];
  const facets = new Set((workspace?.uiFacets as string[] | undefined) ?? ["agent", "library", "settings"]);
  const sessions = (workspace?.sessions as Array<{ id: string; title?: string }> | undefined) ?? [];

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <strong>{i18n.t("app.title")}</strong>
        <span className="text-sm text-[var(--color-subtle)]">{host.layout.channel === "release" ? i18n.t("app.channel.release") : host.layout.channel === "test" ? i18n.t("app.channel.test") : i18n.t("app.channel.development")}</span>
      </header>
      {error ? <div role="alert" className="px-4 py-2 text-[var(--color-danger)]">{error}</div> : null}
      {notice ? <div role="status" className="px-4 py-2 text-[var(--color-subtle)]">{notice}</div> : null}
      {restartRequired ? <div role="status" className="px-4 py-2 text-[var(--color-danger)]">{i18n.t("settings.restartRequired")}</div> : null}
      {setupNeeded ? (
        <div role="status" className="px-4 py-2 bg-[var(--color-accent-soft)]">
          {i18n.t("setup.needed")}
          <button className="ml-3 border px-2 py-1 rounded" onClick={() => void window.manga.command({ commandId: "settings.skipAi", idempotencyKey: id(), input: {} }).then(() => refresh())}>{i18n.t("setup.skipAi")}</button>
        </div>
      ) : null}
      <Tabs.Root value={page} onValueChange={setPage} className="flex-1 flex min-h-0">
        <Tabs.List className="w-52 border-r border-[var(--color-border)] bg-[var(--color-surface)] p-2 flex flex-col gap-1" aria-label="主导航">
          {facets.has("agent") ? <Tabs.Trigger value="agent" data-testid="nav-agent" className="flex items-center gap-2 px-3 py-2 rounded data-[state=active]:bg-[var(--color-accent-soft)]"><Bot size={16} />{i18n.t("nav.agent")}</Tabs.Trigger> : null}
          {facets.has("agent") ? <Tabs.Trigger value="copilot" data-testid="nav-copilot" className="flex items-center gap-2 px-3 py-2 rounded data-[state=active]:bg-[var(--color-accent-soft)]"><Sidebar size={16} />{i18n.t("nav.copilot")}</Tabs.Trigger> : null}
          {facets.has("library") || facets.has("inventory") ? <Tabs.Trigger value="library" data-testid="nav-library" className="flex items-center gap-2 px-3 py-2 rounded data-[state=active]:bg-[var(--color-accent-soft)]"><FolderSearch size={16} />{i18n.t("nav.library")}</Tabs.Trigger> : null}
          {facets.has("settings") ? <Tabs.Trigger value="settings" data-testid="nav-settings" className="flex items-center gap-2 px-3 py-2 rounded data-[state=active]:bg-[var(--color-accent-soft)]"><Settings size={16} />{i18n.t("nav.settings")}</Tabs.Trigger> : null}
        </Tabs.List>
        <div className="flex-1 min-w-0 overflow-auto p-4">
          <Tabs.Content value="agent" className="h-full flex flex-col gap-3">
            <p className="text-sm text-[var(--color-subtle)]">{i18n.t("agent.shared")}</p>
            <SessionList i18n={i18n} sessions={sessions} runs={(workspace?.runs as Array<{ id: string; sessionId: string; status: string; inputText?: string }> | undefined) ?? []} current={sessionId} onSelect={(value) => { setSessionId(value); void refresh(value); }} />
            <AgentPane i18n={i18n} run={run} sessionRuns={((workspace?.runs as Array<{ id: string; sessionId: string; status: string; inputText?: string }> | undefined) ?? []).filter((entry) => entry.sessionId === sessionId)} draft={draft} setDraft={setDraft} composing={composing} setComposing={setComposing} resources={resources} materials={materials} setMaterials={setMaterials} onSend={() => void send()} onStop={() => void stop()} onRetry={() => void retry()} />
          </Tabs.Content>
          <Tabs.Content value="copilot">
            <p className="text-sm text-[var(--color-subtle)] mb-3">{i18n.t("agent.shared")}</p>
            <AgentPane i18n={i18n} run={run} sessionRuns={((workspace?.runs as Array<{ id: string; sessionId: string; status: string; inputText?: string }> | undefined) ?? []).filter((entry) => entry.sessionId === sessionId)} draft={draft} setDraft={setDraft} composing={composing} setComposing={setComposing} resources={resources} materials={materials} setMaterials={setMaterials} onSend={() => void send()} onStop={() => void stop()} onRetry={() => void retry()} />
          </Tabs.Content>
          <Tabs.Content value="library">
            <LibraryPane
              i18n={i18n}
              inventory={inventory}
              onImport={() => void window.manga.chooseFile().then(() => refresh())}
              onScan={() => void window.manga.command({ commandId: "inventory.scan", idempotencyKey: id(), input: {} }).then((item) => setInventory(item.value ?? null))}
              onCancel={() => void window.manga.command({ commandId: "inventory.cancelScan", idempotencyKey: id(), input: { scanId: "current" } })}
              onTranscribe={() => void window.manga.chooseAudio().then(async (handle) => {
                if (!handle) return;
                const result = await window.manga.command({ commandId: "library.transcribeAudio", idempotencyKey: id(), input: { pathHandle: handle } });
                if (result.status === "error") setError(result.error?.message);
                else setNotice(String(result.value?.text ?? ""));
              })}
              onReveal={(itemId) => void window.manga.reveal(itemId).then((result) => { if (result.status === "error") setError(result.error?.message); })}
              onRepair={(itemId) => void window.manga.command({ commandId: "inventory.repair", idempotencyKey: id(), input: { id: itemId } }).then((result) => { if (result.status === "error") setError(result.error?.message); else void refresh(); })}
            />
          </Tabs.Content>
          <Tabs.Content value="settings">
            <SettingsPane
              i18n={i18n}
              host={host}
              settings={settings}
              migration={migration}
              onApplyMigration={() => void applyMigration()}
              onCancelMigration={() => setMigration(null)}
              onRollbackRecovery={() => void rollbackRecovery()}
              onRecoverJobs={() => void window.manga.command({ commandId: "settings.recoverJobs", idempotencyKey: id(), input: { action: "recover" } }).then((result) => { if (result.status === "error") setError(result.error?.message); void refresh(); })}
              onPointerLocation={() => void window.manga.chooseDirectory().then(async (handle) => {
                if (!handle) return;
                const result = await window.manga.command({ commandId: "settings.setLayout", idempotencyKey: id(), input: { pointerPathHandle: handle } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              })}
              formatDate={i18n.formatDate}
              formatNumber={i18n.formatNumber}
              onSkip={() => void window.manga.command({ commandId: "settings.skipAi", idempotencyKey: id(), input: {} }).then(() => refresh())}
              onChooseLocation={() => void chooseLocation()}
              onIndexedRoot={() => void window.manga.chooseDirectory().then(async (handle) => {
                if (!handle) return;
                const result = await window.manga.command({ commandId: "library.indexExternal", idempotencyKey: id(), input: { pathHandle: handle } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              })}
              onRuntime={async (runtime) => {
                const result = await window.manga.command({ commandId: "settings.setRuntime", idempotencyKey: id(), input: { runtime } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              }}
              onSaveConnection={saveConnection}
              onDeleteConnection={async (connectionId) => {
                const result = await window.manga.command({ commandId: "connections.delete", idempotencyKey: id(), input: { connectionId } });
                if (result.status === "error") setError(result.error?.message);
                await refresh();
              }}
              onTestConnection={async (connectionId, capability) => {
                const result = await window.manga.command({ commandId: "connections.test", idempotencyKey: id(), input: { connectionId, capability } });
                if (result.status === "error") setError(result.error?.message);
                else setNotice(i18n.t("settings.testConnection"));
                await refresh();
              }}
            />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  );
}

function SessionList(props: { i18n: ReturnType<typeof createTranslator>; sessions: Array<{ id: string; title?: string }>; runs: Array<{ id: string; sessionId: string; status: string; inputText?: string }>; current?: string; onSelect: (id: string) => void }) {
  if (!props.sessions.length) return null;
  return (
    <section>
      <h2 className="text-sm mb-1">{props.i18n.t("agent.history")}</h2>
      <ul className="flex flex-wrap gap-2 text-sm">
        {props.sessions.map((session) => {
          const count = props.runs.filter((run) => run.sessionId === session.id).length;
          return (
            <li key={session.id}>
              <button data-testid={`session-${session.id}`} className={`border px-2 py-1 rounded ${props.current === session.id ? "bg-[var(--color-accent-soft)]" : ""}`} onClick={() => props.onSelect(session.id)}>{session.title ?? session.id} · {count}</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AgentPane(props: {
  i18n: ReturnType<typeof createTranslator>;
  run: Record<string, unknown> | null;
  sessionRuns: Array<{ id: string; sessionId: string; status: string; inputText?: string }>;
  draft: string;
  setDraft: (value: string) => void;
  composing: boolean;
  setComposing: (value: boolean) => void;
  resources: Array<{ id: string; title: string }>;
  materials: string[];
  setMaterials: (value: string[]) => void;
  onSend: () => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  const toggle = (resourceId: string, checked: boolean) => {
    props.setMaterials(checked ? [...new Set([...props.materials, resourceId])] : props.materials.filter((item) => item !== resourceId));
  };
  const status = String(props.run?.status ?? (props.run ? "succeeded" : ""));
  return (
    <>
      <fieldset className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)]">
        <legend className="text-sm px-1">{props.i18n.t("agent.materials")}</legend>
        {props.resources.length === 0 ? <p className="text-sm text-[var(--color-subtle)]">{props.i18n.t("agent.materialsNone")}</p> : (
          <ul className="grid gap-1 max-h-32 overflow-auto text-sm">
            {props.resources.map((resource) => (
              <li key={resource.id}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={props.materials.includes(resource.id)} onChange={(event) => toggle(resource.id, event.target.checked)} />
                  <span>{resource.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-[var(--color-subtle)] mt-1">{props.i18n.t("agent.scope")}：{props.i18n.t("agent.scopeCount", { count: props.materials.length })}</p>
      </fieldset>
      <section className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] min-h-40" data-testid="agent-thread">
        <h2 className="font-medium mb-2">{props.i18n.t("agent.tools")}</h2>
        {props.sessionRuns.length ? (
          <ol className="text-sm space-y-2 mb-3">
            {props.sessionRuns.slice().reverse().map((entry) => (
              <li key={entry.id} data-testid={`run-${entry.id}`}>
                <div className="text-[var(--color-subtle)]">{props.i18n.t("agent.status", { status: entry.status })}</div>
                <p>{props.i18n.t("agent.userTurn")}: {entry.inputText || String(props.run?.inputText ?? "")}</p>
              </li>
            ))}
          </ol>
        ) : null}
        {props.run ? <p className="text-xs text-[var(--color-subtle)] mb-1">{props.i18n.t("agent.status", { status })} · {props.i18n.t("agent.grant", { handle: String(props.run.grantHandle ?? "-") })}</p> : null}
        {props.run?.inputText ? <p className="text-sm mb-2" data-testid="agent-input">{String(props.run.inputText)}</p> : null}
        {props.run ? <Markdown remarkPlugins={[remarkGfm]}>{String(props.run.text || props.run.liveText || props.i18n.t("agent.empty"))}</Markdown> : <p>{props.i18n.t("agent.empty")}</p>}
        {Array.isArray(props.run?.tools) ? <pre className="text-xs mt-2 whitespace-pre-wrap">{JSON.stringify(props.run?.tools, null, 2)}</pre> : null}
        {Array.isArray(props.run?.messages) ? <pre className="text-xs mt-2 whitespace-pre-wrap" data-testid="agent-messages">{JSON.stringify(props.run?.messages, null, 2)}</pre> : null}
      </section>
      <label className="block">
        <span className="text-sm">{props.i18n.t("agent.composer")}</span>
        <textarea
          data-testid="agent-composer"
          className="w-full mt-1 min-h-24 border border-[var(--color-border)] rounded p-2"
          value={props.draft}
          onChange={(event) => props.setDraft(event.target.value)}
          onCompositionStart={() => props.setComposing(true)}
          onCompositionEnd={() => props.setComposing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !props.composing) {
              event.preventDefault();
              props.onSend();
            }
          }}
        />
      </label>
      <div className="flex gap-2">
        <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" data-testid="agent-send" onClick={props.onSend}>{props.i18n.t("agent.send")}</button>
        <button className="border border-[var(--color-border)] px-3 py-1 rounded" data-testid="agent-stop" onClick={props.onStop}>{props.i18n.t("agent.stop")}</button>
        <button className="border border-[var(--color-border)] px-3 py-1 rounded" data-testid="agent-retry" onClick={props.onRetry}>{props.i18n.t("agent.retry")}</button>
      </div>
    </>
  );
}

function LibraryPane(props: {
  i18n: ReturnType<typeof createTranslator>;
  inventory: Record<string, unknown> | null;
  onImport: () => void;
  onScan: () => void;
  onCancel: () => void;
  onTranscribe: () => void;
  onReveal: (id: string) => void;
  onRepair: (id: string) => void;
}) {
  const items = (props.inventory?.items as Array<Record<string, unknown>> | undefined) ?? [];
  const totals = props.inventory?.totals as Record<string, { count?: number; bytes?: number }> | undefined;
  return (
    <section>
      <div className="flex gap-2 mb-3 flex-wrap">
        <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" onClick={props.onImport}>{props.i18n.t("library.import")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onScan}>{props.i18n.t("library.scan")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onCancel}>{props.i18n.t("library.cancelScan")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onTranscribe}>{props.i18n.t("library.transcribe")}</button>
      </div>
      {totals ? <p className="text-sm text-[var(--color-subtle)] mb-2">{props.i18n.t("library.count", { count: Number(totals.resource?.count ?? 0) })} · {props.i18n.t("library.bytes", { value: Number(totals.resource?.bytes ?? 0) })}</p> : null}
      {items.length === 0 ? <p>{props.i18n.t("status.empty")}</p> : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={String(item.id)} className="border border-[var(--color-border)] rounded p-2 bg-[var(--color-surface)]">
              <div>{String(item.title)}</div>
              <div className="text-sm text-[var(--color-subtle)]">{String(item.kind)} · {item.hosted ? props.i18n.t("library.hosted") : props.i18n.t("library.indexed")} · {item.available === false ? props.i18n.t("library.unavailable") : props.i18n.t("library.available")} · {props.i18n.t("library.bytes", { value: Number(item.bytes ?? 0) })}</div>
              {item.revealable ? <button className="text-sm mt-1 border px-2 py-0.5 rounded" onClick={() => props.onReveal(String(item.id))}>{props.i18n.t("library.reveal")}</button> : null}
              {item.available === false ? <button className="text-sm mt-1 ml-2 border px-2 py-0.5 rounded" onClick={() => props.onRepair(String(item.id))}>{props.i18n.t("library.repair")}</button> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecoveryJobs(props: { i18n: ReturnType<typeof createTranslator>; jobs: Array<{ id: string; kind: string; stage: string; status: string }>; onRollback: () => void; onRecover: () => void }) {
  return (
    <section className="space-y-1">
      <h3 className="font-medium">{props.i18n.t("settings.recoveryJobs")}</h3>
      {props.jobs.length === 0 ? <p className="text-sm text-[var(--color-subtle)]">{props.i18n.t("settings.recoveryNone")}</p> : (
        <>
          <ul className="text-sm">
            {props.jobs.map((job) => <li key={job.id}>{job.kind} · {job.stage} · {job.status}</li>)}
          </ul>
          <div className="flex gap-2">
            <button className="border px-3 py-1 rounded" onClick={props.onRecover}>{props.i18n.t("settings.recoveryResume")}</button>
            <button className="border px-3 py-1 rounded" onClick={props.onRollback}>{props.i18n.t("settings.recoveryRollback")}</button>
          </div>
        </>
      )}
    </section>
  );
}

function SettingsPane(props: {
  i18n: ReturnType<typeof createTranslator>;
  host: Awaited<ReturnType<Window["manga"]["state"]>>;
  settings: Record<string, unknown> | null;
  migration: { checkpointId: string; copies: Array<{ partition: string; bytes: number; target: string }> } | null;
  onApplyMigration: () => void;
  onCancelMigration: () => void;
  onRollbackRecovery: () => void;
  onRecoverJobs: () => void;
  onPointerLocation: () => void;
  formatDate: (value: string | Date) => string;
  formatNumber: (value: number) => string;
  onSkip: () => void;
  onChooseLocation: () => void;
  onIndexedRoot: () => void;
  onRuntime: (runtime: string) => Promise<void>;
  onSaveConnection: (fields: ConnectionForm) => Promise<void>;
  onDeleteConnection: (id: string) => Promise<void>;
  onTestConnection: (id: string, capability: string) => Promise<void>;
}) {
  const [form, setForm] = useState<ConnectionForm>(emptyForm);
  const connections = (props.settings?.connections as Array<Record<string, unknown>> | undefined) ?? [];
  const runtime = String(props.settings?.aiRuntime ?? "native");
  return (
    <section className="space-y-4 max-w-2xl">
      <h2 className="font-medium">{props.i18n.t("setup.title")}</h2>
      <p>{props.i18n.t("setup.aiOptional")}</p>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt>{props.i18n.t("setup.channel")}</dt><dd>{props.host.layout.channel}</dd>
        <dt>{props.i18n.t("setup.pointer")}</dt><dd>{props.host.layout.pointerPath}</dd>
        {Object.entries(props.host.layout.partitions).map(([name, value]) => (
          <span key={name} className="contents"><dt>{props.i18n.t("settings.partition", { name })}</dt><dd>{value}</dd></span>
        ))}
      </dl>
      <label className="block text-sm">
        {props.i18n.t("settings.runtime")}
        <select className="border w-full p-2 rounded mt-1" aria-label={props.i18n.t("settings.runtime")} value={runtime} onChange={(event) => void props.onRuntime(event.target.value)}>
          <option value="native">{props.i18n.t("settings.runtimeNative")}</option>
          <option value="pi">{props.i18n.t("settings.runtimePi")}</option>
        </select>
      </label>
      <div className="flex gap-2 flex-wrap">
        <button className="border px-3 py-1 rounded" onClick={props.onSkip}>{props.i18n.t("setup.skipAi")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onChooseLocation}>{props.i18n.t("settings.chooseDirectory")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onPointerLocation}>{props.i18n.t("settings.choosePointer")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onIndexedRoot}>{props.i18n.t("settings.chooseIndexed")}</button>
      </div>
      {props.migration ? (
        <section role="region" aria-label={props.i18n.t("settings.migrationPlan")} className="border border-[var(--color-border)] rounded p-3 bg-[var(--color-surface)] space-y-2">
          <h3 className="font-medium">{props.i18n.t("settings.migrationPlan")}</h3>
          <p className="text-sm">{props.i18n.t("settings.migrationSummary", { count: props.migration.copies.length, bytes: props.formatNumber(props.migration.copies.reduce((sum, copy) => sum + copy.bytes, 0)) })}</p>
          <ul className="text-sm text-[var(--color-subtle)]">
            {props.migration.copies.map((copy) => <li key={copy.partition}>{copy.partition} · {copy.target} · {props.i18n.t("library.bytes", { value: copy.bytes })}</li>)}
          </ul>
          <div className="flex gap-2">
            <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" onClick={props.onApplyMigration}>{props.i18n.t("settings.migrationApply")}</button>
            <button className="border px-3 py-1 rounded" onClick={props.onCancelMigration}>{props.i18n.t("settings.migrationCancel")}</button>
          </div>
        </section>
      ) : null}
      <RecoveryJobs i18n={props.i18n} jobs={(props.settings?.recoveryJobs as Array<{ id: string; kind: string; stage: string; status: string }> | undefined) ?? []} onRollback={props.onRollbackRecovery} onRecover={props.onRecoverJobs} />
      <section className="space-y-2">
        <h3>{props.i18n.t("settings.connections")}</h3>
        <ul className="space-y-2 text-sm">
          {connections.map((connection) => (
            <li key={String(connection.id)} className="border rounded p-2">
              <div>{String(connection.label)} · {String(connection.purpose)} · {String(connection.protocol)} · {String(connection.runtime ?? "native")}</div>
              <div className="text-[var(--color-subtle)]">{String(connection.baseUrl)} · {String(connection.modelId)}</div>
              <div className="flex gap-1 flex-wrap mt-1">
                <button className="border px-2 py-0.5 rounded" onClick={() => setForm({
                  id: String(connection.id),
                  label: String(connection.label),
                  protocol: String(connection.protocol),
                  runtime: String(connection.runtime ?? "native"),
                  baseUrl: String(connection.baseUrl),
                  modelId: String(connection.modelId),
                  purpose: String(connection.purpose),
                  timeoutMs: String(connection.timeoutMs ?? 60_000),
                  secret: "",
                })}>{props.i18n.t("settings.editConnection")}</button>
                <button className="border px-2 py-0.5 rounded" onClick={() => void props.onTestConnection(String(connection.id), connection.purpose === "transcription" ? "transcription" : connection.purpose === "embedding" ? "embedding" : "text")}>{props.i18n.t("settings.testConnection")}</button>
                {connection.purpose === "text" ? (
                  <>
                    <button className="border px-2 py-0.5 rounded" onClick={() => void props.onTestConnection(String(connection.id), "tools")}>{props.i18n.t("settings.testTools")}</button>
                    <button className="border px-2 py-0.5 rounded" onClick={() => void props.onTestConnection(String(connection.id), "streaming")}>{props.i18n.t("settings.testStreaming")}</button>
                  </>
                ) : null}
                <button className="border px-2 py-0.5 rounded" onClick={() => void props.onDeleteConnection(String(connection.id))}>{props.i18n.t("settings.deleteConnection")}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void props.onSaveConnection(form).then(() => setForm(emptyForm())); }}>
        <input className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.baseUrl")} value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <input className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.modelId")} value={form.modelId} onChange={(event) => setForm({ ...form, modelId: event.target.value })} />
        <input className="border w-full p-2 rounded" type="password" aria-label={props.i18n.t("settings.apiKey")} value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} />
        <select className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.protocol")} value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value })}>
          <option value="openai-chat-completions">openai-chat-completions</option>
          <option value="openai-responses">openai-responses</option>
        </select>
        <select className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.purposeText")} value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })}>
          <option value="text">{props.i18n.t("settings.purposeText")}</option>
          <option value="transcription">{props.i18n.t("settings.purposeTranscription")}</option>
          <option value="embedding">{props.i18n.t("settings.purposeEmbedding")}</option>
        </select>
        <select className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.runtime")} value={form.runtime} onChange={(event) => setForm({ ...form, runtime: event.target.value })}>
          <option value="native">{props.i18n.t("settings.runtimeNative")}</option>
          <option value="pi">{props.i18n.t("settings.runtimePi")}</option>
        </select>
        <input className="border w-full p-2 rounded" aria-label={props.i18n.t("settings.timeout")} value={form.timeoutMs} onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })} />
        <button className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" type="submit">{props.i18n.t("settings.saveConnection")}</button>
      </form>
      <p className="text-sm text-[var(--color-subtle)]">{props.formatDate(new Date())} · {props.formatNumber(1250)}</p>
    </section>
  );
}
