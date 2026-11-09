/** What light open's window shows, as the main process says (`window.mangaLight`, preload-light.ts). */
export type LightOpened =
  | { sessionId: string; kind: "video"; name: string; key: string; resourceId: string; revisionId: string; durationMs: number; audio: Array<{ index: number; codec: string; language: string | null; title: string | null; channels: number | null; default: boolean }>; siblings: { previous: boolean; next: boolean } }
  | { sessionId: string; kind: "comic"; name: string; key: string; resourceId: string; revisionId: string; startPageId: string | null; pageCount: number; siblings: { previous: boolean; next: boolean } };

export type LightState = {
  opened: LightOpened | null;
  error: { kind: "missing" | "unsupported" | "broken"; detail: string } | null;
  resume: { positionMs: number } | { pageId: string } | null;
  version: string;
  types: { video: string[]; comic: string[]; image: string[] };
};

export type LightPositionUpdate =
  | { sessionId?: string; kind: "video"; positionMs: number; durationMs: number; finished: boolean }
  | { sessionId?: string; kind: "comic"; pageId: string; pageIndex: number; pageCount: number; finished: boolean };

export type LightHost = {
  state(): Promise<LightState>;
  openDialog(): Promise<LightState>;
  openDropped(file: File): Promise<LightState>;
  sibling(direction: 1 | -1): Promise<{ moved: boolean }>;
  reveal(): Promise<void>;
  position(update: LightPositionUpdate): Promise<void>;
  onChanged(listener: () => void): () => void;
  onSaveNow(listener: () => unknown): () => void;
};

export const lightHost = (): LightHost | undefined => (window as unknown as { mangaLight?: LightHost }).mangaLight;

/** A video watched to within this of its end starts again from the beginning next time, as in the full app (`FINISHED_WITHIN_MS`). */
export const FINISHED_WITHIN_MS = 5000;
