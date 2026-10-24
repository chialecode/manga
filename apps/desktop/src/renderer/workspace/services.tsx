import { createContext, useContext } from "react";
import type { ContextId, ObjectListKind, SidebarOpen } from "@manga/contracts";
import type { ShellPreference } from "@manga/contracts/reading";
import type { SegmentAnchor } from "@manga/contracts/media";
import type { Translator } from "@manga/i18n";
import type { ProjectTab } from "../pages/projects/project-page.tsx";
import type { SemanticHitView } from "../lib/semantic-model.ts";
import type { SettingsPageId } from "../lib/shell-model.ts";
import type { HostState } from "../lib/api.ts";
import type { WorkMediaKind, WorkSummary } from "../lib/works.ts";
import type { ScreenshotPort } from "../hooks/use-screenshots.tsx";
import type { RecorderHandle } from "../voice/use-recorder.ts";
import type { useScan } from "../hooks/use-scan.ts";
import type { usePackage } from "../hooks/use-package.ts";
import type { useKeyBindings } from "../hooks/use-key-bindings.ts";
import type { ReadingStylePatch } from "@manga/contracts/reading";

/** How an open is done: behind the tab in front (Ctrl + click, middle click), or as a tab of its own. */
export type OpenOptions = { background?: boolean; mode?: "reuse" | "new"; title?: string };

/** What every opening of a thing in the workspace goes through, so a tab, a menu and the Agent's links all open things the same way. */
export type Openers = {
  /** A resource in its reader, after the check that its file can be opened (A-86). `silent` is a restore: it says nothing when the file cannot be opened. */
  resource(input: { resourceId: string; mediaKind?: WorkMediaKind | null; workId?: string | null }, options?: OpenOptions & { silent?: boolean; launch?: Record<string, unknown> }): Promise<void>;
  continueWork(summary: WorkSummary, options?: OpenOptions): void;
  /** Another file of the same work (the next episode) in the tab that is showing one: the tab's own history keeps the one it left. */
  episode(tabId: string, resourceId: string): Promise<void>;
  /** A work's page, in a library tab (the one asked from if it is given, else a tab of its own). */
  work(workId: string, options?: OpenOptions & { kind?: WorkMediaKind | null; tab?: "cover" | "match" }): void;
  library(page?: "overview" | "novel" | "comic" | "video", options?: OpenOptions): void;
  note(objectId: string, focusBlockId?: string, options?: OpenOptions): void;
  noteSource(objectId: string, blockId?: string): Promise<void>;
  anchor(anchor: Pick<SegmentAnchor, "resourceId" | "resourceRevisionId" | "locator">): Promise<void>;
  screenshot(screenshotId: string): Promise<void>;
  semanticHit(hit: SemanticHitView): void;
  /** A project: its context becomes the one on screen and its home opens there. `null` is the overview of the projects. */
  project(projectId: string | null, tab?: ProjectTab, focus?: { kind: string; id: string } | null): Promise<void>;
  projectMaterial(material: { kind: string; targetId: string; opens?: { resourceId: string; mediaKind: string; workId: string | null; position?: { kind: "temporal"; startMs: number } | { kind: "image"; pageId: string } } }): void;
  embed(item: { targetKind: string; targetId: string; locator: { blockId?: string; nodeId?: string } }): Promise<void>;
  /** A conversation as a tab; one of another context makes that context the one on screen first. */
  conversation(sessionId: string, options?: { contextId?: string | null; title?: string }): Promise<void>;
  /** A conversation of the history is continued: it becomes the context's current one and opens as a tab. */
  resumeConversation(sessionId: string): Promise<void>;
  /** Something the sidebar or the search found, in the context it belongs to and as the tab of its kind (交互设计 2.10); one of another context makes that context the one on screen first. */
  item(found: { open: SidebarOpen; contextId?: ContextId; title?: string }, options?: { background?: boolean }): Promise<void>;
  /** The settings view (A-101): not a tab; the workspace stays mounted behind it. */
  settings(page?: SettingsPageId): void;
  /** The records tab of one type (the conversations or the notes, or all); the records of one work when it is given. */
  records(options?: { type?: "all" | "conversation" | "note"; workId?: string }): void;
  /** The management tab of one kind of a project's objects: every project's whiteboards, maps, drafts or cuts. */
  objects(kind: ObjectListKind): void;
  /** A new whiteboard, map, draft or cut in the project, opened as a tab of it. */
  createObject(kind: ObjectListKind, projectId: string): Promise<boolean>;
  /** The search box (A-100), with a scope (a view of the rail) when it is asked from one; null searches everything, and none takes the view on screen. */
  search(query?: string, scope?: string | null): void;
  downloads(): void;
  keys(): void;
  newTab(): void;
  reopenTab(): void;
  closeTab(): void;
  /** "最近" or a project becomes the context on screen. */
  switchContext(contextId: string | null): Promise<void>;
  newConversation(): Promise<void>;
  newProject(): void;
};

/** What the contents of the tabs get from the application around them. */
export type Services = {
  i18n: Translator;
  t: Translator["t"];
  host: HostState;
  facets: ReadonlySet<string>;
  shell: ShellPreference;
  /** The context on screen: a project id, null for "最近". */
  currentContext: string | null;
  settings: Record<string, unknown> | null;
  workspace: Record<string, unknown> | null;
  setError: (message?: string) => void;
  setNotice: (message?: string, action?: { label: string; onClick: () => void }) => void;
  /** Reads the workspace, the settings and the host state again. */
  refresh: () => Promise<void>;
  /** Changes when something a shelf shows may have changed. */
  shelfKey: number;
  bump: () => void;
  /** Changes when a project may have changed, so the page that shows it reads it again. */
  projectsVersion: number;
  changedProjects: () => void;
  scan: ReturnType<typeof useScan>;
  pkg: ReturnType<typeof usePackage>;
  recorder: RecorderHandle;
  voiceOn: boolean;
  keyBindings: ReturnType<typeof useKeyBindings>;
  screenshots: ScreenshotPort;
  /** The window's own full screen of the focused reader. */
  openMatch: (workId: string) => void;
  matchVersion: number;
  reviewRecording: (target: { sessionId?: string; workId?: string; resourceId?: string }) => void;
  saveReadingStyle: (patch: ReadingStylePatch) => Promise<void>;
  /** Changes when the conversations may have changed, so the sidebar and an open history read them again. */
  conversationVersion: number;
  conversationsChanged: () => void;
  /** Changes when what the sidebar lists may have changed without its doing (`lib/lists-changed.ts`), so the lists read it again. */
  listsVersion: number;
  open: Openers;
};

const Context = createContext<Services | null>(null);
export const ServicesProvider = Context.Provider;

export function useServices(): Services {
  const services = useContext(Context);
  if (!services) throw new Error("no services around this component");
  return services;
}
