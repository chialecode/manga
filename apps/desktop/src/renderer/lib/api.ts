/** The renderer's one door to the main process: typed `window.manga`, and `call` for commands that throw on failure. */

export type CommandResult<T = Record<string, unknown>> = {
  status: "ok" | "error";
  value?: T;
  error?: { code: string; message: string; retryable?: boolean; details?: unknown };
};

export type HostState = {
  layout: { channel: string; pointerPath: string; partitions: Record<string, string>; writable: boolean; recovery: string };
  writable: boolean;
  vaultAvailable: boolean;
  packaged?: boolean;
  appVersion?: string;
};

export type PickRequest = { mode: "file" | "directory"; filter?: "book" | "comic" | "video" | "subtitle" | "image" | "audio" | "package" | "any" };
export type PickResult = { pathHandle: string; name: string; mode: "file" | "directory" };

export type Notice = { topic: string; payload: Record<string, unknown> };

/** What the floating recording box shows; the main window publishes it, the box only displays it. */
export type OverlayState = {
  phase: "recording" | "stopping";
  elapsedMs: number;
  level: number;
  retention: "keep" | "discard";
  mode: "hold" | "toggle";
  label: string;
  strings: { recording: string; stopping: string; stop: string; keep: string; discard: string; hold: string; toggle: string };
};

export interface MangaHost {
  command(payload: { commandId: string; idempotencyKey: string; input: unknown }): Promise<CommandResult>;
  state(): Promise<HostState>;
  chooseDirectory(): Promise<string | null>;
  chooseFile(): Promise<CommandResult | null>;
  chooseBook(): Promise<CommandResult | null>;
  choosePath(): Promise<string | null>;
  chooseAudio(): Promise<string | null>;
  pick?(request: PickRequest): Promise<PickResult | null>;
  onNotice?(listener: (notice: Notice) => void): () => void;
  stashSecret(value: string): Promise<string | null>;
  reveal(id: string): Promise<CommandResult>;
  /** Only pages on the allow list open, in the system browser. */
  openExternal?(url: string): Promise<boolean>;
  overlay?: {
    publish(state: OverlayState | null): void;
    onStop(listener: () => void): () => void;
  };
}

declare global {
  interface Window {
    manga: MangaHost;
  }
}

export const uid = (): string => crypto.randomUUID();

/** Command results cross the IPC boundary, so a list is only trusted after an array check. */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export class CommandError extends Error {
  code: string;
  retryable: boolean;
  details: unknown;
  constructor(error: { code?: string; message?: string; retryable?: boolean; details?: unknown } | undefined) {
    super(error?.message ?? "command failed");
    this.name = "CommandError";
    this.code = error?.code ?? "UNKNOWN";
    this.retryable = error?.retryable === true;
    this.details = error?.details;
  }
}

/** Run a command and return its value; a failed command throws a `CommandError` the caller can show. */
export async function call<T = Record<string, unknown>>(commandId: string, input: unknown = {}, options: { key?: string } = {}): Promise<T> {
  const result = await window.manga.command({ commandId, idempotencyKey: options.key ?? uid(), input });
  if (result.status === "error") throw new CommandError(result.error);
  return (result.value ?? {}) as T;
}

/** Like `call`, but a failure comes back as a value, for places that render the error themselves. */
export async function attempt<T = Record<string, unknown>>(commandId: string, input: unknown = {}, options: { key?: string } = {}): Promise<{ ok: true; value: T } | { ok: false; error: CommandError }> {
  try {
    return { ok: true, value: await call<T>(commandId, input, options) };
  } catch (error) {
    return { ok: false, error: error instanceof CommandError ? error : new CommandError({ message: error instanceof Error ? error.message : String(error) }) };
  }
}

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** A module that is turned off answers with this code; pages show their "turned off" state instead of an error. */
export const isModuleOff = (error: unknown): boolean => error instanceof CommandError && (error.code === "CAPABILITY_UNAVAILABLE" || error.code === "COMMAND_UNAVAILABLE" || error.code === "UNKNOWN_COMMAND");
