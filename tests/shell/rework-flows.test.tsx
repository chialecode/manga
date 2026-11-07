/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { BUILTIN_QUICK_TASKS, type QuickTask } from "@manga/contracts";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { Capsule } from "../../apps/desktop/src/renderer/components/chat/capsule.tsx";
import { MessageList, type BubbleActions } from "../../apps/desktop/src/renderer/components/chat/messages.tsx";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { DebugPanel, DEFAULT_DEBUG_VIEW, type DebugView } from "../../apps/desktop/src/renderer/pages/debug-panel.tsx";
import { MatchDialog } from "../../apps/desktop/src/renderer/pages/work-match.tsx";
import { draftProblem } from "../../apps/desktop/src/renderer/pages/settings/quick-tasks-page.tsx";
import { WorkHome } from "../../apps/desktop/src/renderer/pages/work-home.tsx";
import type { StreamNote } from "../../apps/desktop/src/renderer/hooks/use-session-stream.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

/**
 * The rework's pages that the older flow tests do not reach (A-47…A-52): the work's profile with its blanks, the match dialog's
 * reference and preview, the four kinds of note in the message list and the jump from each, the capsule, the debug panel, the
 * settings pages and what the records list asks for.
 */
const i18n = createTranslator("zh-CN");
const t = i18n.t;

type Handler = (input: Record<string, unknown>) => unknown;
type Call = { commandId: string; input: Record<string, unknown> };

function installHost(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const base: Record<string, Handler> = {
    "workspace.get": () => ({ uiFacets: ["agent", "library", "settings", "comic", "video", "notes", "metadata"], sessions: [], runs: [], notes: [], resources: [] }),
    "workspace.sessions": () => [{ sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null }],
    "inventory.overview": () => ({ items: [], totals: {} }),
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "notes.list": () => [],
    "covers.list": () => ({ workId: "wc", state: "auto", coverId: null, covers: [] }),
    "quickTasks.list": () => ({ tasks: [] }),
    "session.open": (input) => ({ id: `ses_${String(input.kind)}_${String(input.targetId)}`, kind: input.kind, targetId: input.targetId }),
    "session.stream": () => ({ items: [], hasMore: false, session: { id: "ses", kind: "shared", targetId: null, workId: null, resourceId: null } }),
    "works.list": () => ({ items: [], total: 1, nextCursor: null }),
    ...handlers,
  };
  (window as unknown as { manga: unknown }).manga = {
    async state() { return { layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "d" }, writable: true, recovery: "none" }, writable: true, vaultAvailable: true }; },
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = base[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string; details?: unknown };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed", ...(failure.details ? { details: failure.details } : {}) } };
      }
    },
    onNotice: () => () => undefined,
    async chooseDirectory() { return null; }, async chooseFile() { return null; }, async chooseAudio() { return null; }, async stashSecret() { return null; },
    async reveal() { return { status: "ok", value: {} }; },
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

const fail = (code: string, message: string, details?: unknown) => Object.assign(new Error(message), { code, details });

beforeEach(() => {
  window.innerWidth = 1600;
  installMatchMedia({ reducedMotion: true });
  installPointerEvent();
  resetCovers();
  shelfMemory.reset();
  quoteTags.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); removeMatchMedia(); quoteTags.reset(); readerContext.reset(); });

// ---- the work's profile -----------------------------------------------------------------------------------

type Field = { value: string | string[] | null; source: string | null; policy: string; candidates: unknown[] };
const field = (value: Field["value"], source: Field["source"] = null, policy = "none"): Field => ({ value, source, policy, candidates: [] });

describe("the work's profile: blanks can be filled, locked and put back (A-51)", () => {
  function profileHost() {
    let override = { fields: {} as Record<string, unknown>, locked: [] as string[], cleared: [] as string[] };
    const detail = () => {
      const fields: Record<string, Field> = { title: field("合成作品", "filename"), author: field(null), studio: field(null), tags: field(["校园"], "online", "provider") };
      for (const [key, value] of Object.entries(override.fields)) fields[key] = field(value as Field["value"], "user", override.locked.includes(key) ? "locked" : "user");
      for (const key of override.locked) if (!(key in override.fields) && fields[key]) fields[key] = { ...fields[key]!, policy: "locked" };
      return {
        id: "wc", title: "合成作品", author: null, mediaKind: "comic", shelf: "reading", coverId: null, lastResource: null, progress: 0, finishedCount: 0, resourceCount: 0, linked: false,
        createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null, originalTitle: "合成作品", fields, override, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [],
      };
    };
    const host = installHost({
      "works.get": detail,
      "works.setOverride": (input) => { override = { fields: input.fields as Record<string, unknown>, locked: input.locked as string[], cleared: input.cleared as string[] }; return {}; },
    });
    return { host, override: () => override };
  }
  const mount = () => render(<WorkHome t={t} workId="wc" facets={new Set(["library", "comic"])} formatDate={i18n.formatDate} onBack={() => undefined} onOpenResource={() => undefined} onOpenNote={() => undefined} onOpenWork={() => undefined} onChanged={() => undefined} onError={() => undefined} onNotice={() => undefined} />);

  it("shows only what there is while reading, and every field while editing", async () => {
    profileHost();
    mount();
    await waitFor(() => expect(screen.getByTestId("detail-fields")).toBeTruthy());
    expect(screen.getByTestId("field-title")).toBeTruthy();
    expect(screen.getByTestId("field-tags")).toBeTruthy();
    expect(screen.queryByTestId("field-author")).toBeNull();
    expect(screen.queryByTestId("field-studio")).toBeNull();
    fireEvent.click(screen.getByTestId("detail-edit"));
    expect(screen.getByTestId("field-author").textContent).toContain("（空）");
    expect(screen.getByTestId("field-edit-author").textContent).toBe("填写");
    expect(screen.getByTestId("field-edit-title").textContent).toBe("编辑");
    // The count fields come from the source and are not typed by hand.
    expect(screen.queryByTestId("field-edit-episodeCount")).toBeNull();
    fireEvent.click(screen.getByTestId("detail-edit"));
    expect(screen.queryByTestId("field-author")).toBeNull();
  });

  it("fills an empty field, shows it as the user's own, locks it, and puts it back to automatic", async () => {
    const { host, override } = profileHost();
    mount();
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-edit"));
    fireEvent.click(screen.getByTestId("field-edit-author"));
    fireEvent.change(screen.getByTestId("field-input-author"), { target: { value: "  合成作者 " } });
    fireEvent.click(screen.getByTestId("field-save-author"));
    await waitFor(() => expect(host.of("works.setOverride")).toHaveLength(1));
    expect(host.of("works.setOverride")[0]!.input).toEqual({ workId: "wc", fields: { author: "合成作者" }, locked: [], cleared: [] });
    await waitFor(() => expect(screen.getByTestId("field-source-author").textContent).toBe("你自己填写"));
    expect(screen.getByTestId("field-author").textContent).toContain("合成作者");

    fireEvent.click(screen.getByTestId("field-lock-author"));
    await waitFor(() => expect(override().locked).toEqual(["author"]));
    expect(host.of("works.setOverride")[1]!.input).toEqual({ workId: "wc", fields: { author: "合成作者" }, locked: ["author"], cleared: [] });
    await waitFor(() => expect(screen.getByTestId("field-source-author").textContent).toBe("你自己填写 · 已锁定"));
    expect(screen.getByTestId("field-lock-author").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("field-reset-author"));
    await waitFor(() => expect(override()).toEqual({ fields: {}, locked: [], cleared: [] }));
    await waitFor(() => expect(screen.getByTestId("field-author").textContent).toContain("（空）"));
    expect(screen.queryByTestId("field-reset-author")).toBeNull();
  });

  it("keeps a locked blank visible after editing is over, and writes tags as a list", async () => {
    const { host } = profileHost();
    mount();
    await waitFor(() => expect(screen.getByTestId("detail-edit")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-edit"));
    fireEvent.click(screen.getByTestId("field-lock-studio"));
    await waitFor(() => expect(host.of("works.setOverride")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("detail-edit"));
    // A locked blank stays shown, so the lock is not forgotten.
    await waitFor(() => expect(screen.getByTestId("field-studio")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-edit"));
    fireEvent.click(screen.getByTestId("field-edit-tags"));
    fireEvent.change(screen.getByTestId("field-input-tags"), { target: { value: "冒险，校园、 日常" } });
    fireEvent.click(screen.getByTestId("field-save-tags"));
    await waitFor(() => expect(host.of("works.setOverride")).toHaveLength(2));
    expect(host.of("works.setOverride")[1]!.input).toMatchObject({ fields: { tags: ["冒险", "校园", "日常"] }, locked: ["studio"] });
  });
});

// ---- the match dialog -------------------------------------------------------------------------------------

describe("matching a work: number or link, preview, and what is kept (A-51)", () => {
  const detail = (patch: Record<string, unknown> = {}) => ({
    id: "wc", title: "合成漫画", author: null, mediaKind: "comic", shelf: "reading", coverId: null, lastResource: null, progress: 0, finishedCount: 0, resourceCount: 0, linked: false,
    createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null, originalTitle: "合成漫画", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [], ...patch,
  });
  const preview = () => ({
    workId: "wc", mode: "link", providerId: "bangumi", externalId: "42", sourceUrl: "https://bgm.tv/subject/42",
    entry: { title: "合成条目", titleOriginal: "Synthetic", subjectType: 1, episodes: 0, related: 2 },
    kindMismatch: null, linkedElsewhere: null, alreadyLinked: false, replacesLink: null,
    fields: [
      { key: "title", current: { value: "我改的标题", source: "user", policy: "user" }, incoming: "合成条目", status: "differs", protected: true, keepByDefault: true },
      { key: "author", current: { value: "旧作者", source: "filename", policy: "none" }, incoming: "新作者", status: "differs", protected: false, keepByDefault: false },
      { key: "summary", current: { value: "旧简介", source: "file", policy: "none" }, incoming: null, status: "remote-missing", protected: false, keepByDefault: true },
      { key: "tags", current: { value: ["校园"], source: "online", policy: "provider" }, incoming: ["校园"], status: "same", protected: false, keepByDefault: false },
    ],
    cover: { current: { coverId: "cv1", source: "user" }, state: "user", incoming: null, protected: true, willReplace: false },
    warnings: [],
  });
  const mount = (props: { onApplied?: (message: string) => void; onError?: (message: string) => void; onClose?: () => void; refresh?: boolean; detail?: ReturnType<typeof detail> } = {}) => render(
    <MatchDialog t={t} detail={(props.detail ?? detail()) as never} refresh={props.refresh} formatDate={i18n.formatDate} onClose={props.onClose ?? (() => undefined)} onApplied={props.onApplied ?? (() => undefined)} onOpenExternal={() => undefined} onError={props.onError ?? (() => undefined)} />,
  );
  const lookup = async (text: string) => {
    fireEvent.click(screen.getByTestId("match-tab-ref"));
    fireEvent.change(screen.getByTestId("match-ref"), { target: { value: text } });
    fireEvent.click(screen.getByTestId("match-ref-lookup"));
  };

  it("takes a number or a link, shows the entry, and says why a reference was refused", async () => {
    const host = installHost({
      "metadata.candidates": () => ({ candidates: [] }),
      "metadata.resolveRef": (input) => {
        if (input.ref === "not a link") throw fail("VALIDATION_ERROR", "这不是 Bangumi 条目的编号或链接", { reason: "not-an-entry" });
        if (input.ref === "999") throw fail("NOT_FOUND", "no entry");
        if (input.ref === "offline") throw fail("PROVIDER_UNAVAILABLE", "down");
        return { providerId: "bangumi", externalId: "42", entry: { title: "合成条目", titleOriginal: "Synthetic", date: "2020-01-01", subjectType: 1, sourceUrl: "https://bgm.tv/subject/42" }, image: null, kindMismatch: { expected: "comic", actual: "video", subjectType: 2 }, linkedElsewhere: null, alreadyLinked: false };
      },
    });
    mount();
    await lookup("not a link");
    await waitFor(() => expect(screen.getByTestId("match-ref-error").textContent).toBe("这不是 Bangumi 条目的编号或链接"));
    expect(screen.queryByTestId("match-ref-result")).toBeNull();
    fireEvent.change(screen.getByTestId("match-ref"), { target: { value: "999" } });
    fireEvent.click(screen.getByTestId("match-ref-lookup"));
    await waitFor(() => expect(screen.getByTestId("match-ref-error").textContent).toBe(t("match.ref.notFound")));
    fireEvent.change(screen.getByTestId("match-ref"), { target: { value: "offline" } });
    fireEvent.click(screen.getByTestId("match-ref-lookup"));
    await waitFor(() => expect(screen.getByTestId("match-ref-error").textContent).toBe(t("match.offline")));
    fireEvent.change(screen.getByTestId("match-ref"), { target: { value: "https://bgm.tv/subject/42" } });
    fireEvent.click(screen.getByTestId("match-ref-lookup"));
    await waitFor(() => expect(screen.getByTestId("match-ref-result")).toBeTruthy());
    expect(screen.queryByTestId("match-ref-error")).toBeNull();
    expect(screen.getByTestId("match-ref-result").textContent).toContain("合成条目");
    // An entry of another kind is shown with a warning, not refused: the user decides.
    expect(screen.getByTestId("match-ref-mismatch")).toBeTruthy();
    expect(host.of("metadata.resolveRef").map((call) => call.input.ref)).toEqual(["not a link", "999", "offline", "https://bgm.tv/subject/42"]);
    expect(host.of("metadata.resolveRef")[0]!.input).toMatchObject({ workId: "wc" });
    // Looking an entry up writes nothing.
    expect(host.of("metadata.link")).toHaveLength(0);
  });

  it("previews field by field, never overwrites what the user typed unless they say so, and applies exactly what was shown", async () => {
    const applied: string[] = [];
    const host = installHost({
      "metadata.candidates": () => ({ candidates: [] }),
      "metadata.resolveRef": () => ({ providerId: "bangumi", externalId: "42", entry: { title: "合成条目", subjectType: 1, sourceUrl: "https://bgm.tv/subject/42" }, image: null, kindMismatch: null, linkedElsewhere: null, alreadyLinked: false }),
      "metadata.preview": preview,
      "metadata.link": () => ({}),
    });
    mount({ onApplied: (message) => applied.push(message) });
    await lookup("42");
    await waitFor(() => expect(screen.getByTestId("match-ref-choose")).toBeTruthy());
    fireEvent.click(screen.getByTestId("match-ref-choose"));
    await waitFor(() => expect(screen.getByTestId("match-preview")).toBeTruthy());
    expect(host.of("metadata.preview")[0]!.input).toEqual({ workId: "wc", providerId: "bangumi", externalId: "42" });
    // Nothing is written by looking.
    expect(host.of("metadata.link")).toHaveLength(0);

    // The user's own title is protected: shown as theirs, kept, and cannot be unticked.
    const title = within(screen.getByTestId("match-field-title"));
    expect((title.getByTestId("match-keep-title") as HTMLInputElement).checked).toBe(true);
    expect((title.getByTestId("match-keep-title") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("match-field-title").getAttribute("data-protected")).toBe("true");
    // A field the source does not have is kept and says so.
    expect((screen.getByTestId("match-keep-summary") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("match-field-summary").textContent).toContain(t("match.remoteMissing"));
    // A field that differs starts as taken, and an unchanged field is not listed.
    expect((screen.getByTestId("match-keep-author") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId("match-field-tags")).toBeNull();
    // The cover the user chose is protected too.
    expect((screen.getByTestId("match-keep-cover") as HTMLInputElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("match-keep-author"));
    fireEvent.click(screen.getByTestId("match-keep-author"));
    fireEvent.click(screen.getByTestId("match-apply"));
    await waitFor(() => expect(host.of("metadata.link")).toHaveLength(1));
    const sent = host.of("metadata.link")[0]!.input as { keepFields: string[]; keepCover?: boolean };
    expect(sent).toMatchObject({ workId: "wc", providerId: "bangumi", externalId: "42" });
    expect([...sent.keepFields].sort()).toEqual(["summary", "title"]);
    expect(sent.keepCover).toBe(true);
    await waitFor(() => expect(applied).toHaveLength(1));
  });

  it("keeps a field the user ticked, and writes nothing when the dialog is closed from the preview", async () => {
    const host = installHost({
      "metadata.candidates": () => ({ candidates: [] }),
      "metadata.resolveRef": () => ({ providerId: "bangumi", externalId: "42", entry: { title: "合成条目", subjectType: 1, sourceUrl: "https://bgm.tv/subject/42" }, image: null, kindMismatch: null, linkedElsewhere: null, alreadyLinked: false }),
      "metadata.preview": preview,
      "metadata.link": () => ({}),
    });
    mount();
    await lookup("42");
    await waitFor(() => expect(screen.getByTestId("match-ref-choose")).toBeTruthy());
    fireEvent.click(screen.getByTestId("match-ref-choose"));
    await waitFor(() => expect(screen.getByTestId("match-preview")).toBeTruthy());
    fireEvent.click(screen.getByTestId("match-keep-author"));
    fireEvent.click(screen.getByTestId("match-apply"));
    await waitFor(() => expect(host.of("metadata.link")).toHaveLength(1));
    expect([...(host.of("metadata.link")[0]!.input.keepFields as string[])].sort()).toEqual(["author", "summary", "title"]);
    cleanup();

    const second = installHost({
      "metadata.candidates": () => ({ candidates: [] }),
      "metadata.resolveRef": () => ({ providerId: "bangumi", externalId: "42", entry: { title: "合成条目", subjectType: 1, sourceUrl: "https://bgm.tv/subject/42" }, image: null, kindMismatch: null, linkedElsewhere: null, alreadyLinked: false }),
      "metadata.preview": preview,
    });
    const closed: string[] = [];
    mount({ onClose: () => closed.push("closed") });
    await lookup("42");
    await waitFor(() => expect(screen.getByTestId("match-ref-choose")).toBeTruthy());
    fireEvent.click(screen.getByTestId("match-ref-choose"));
    await waitFor(() => expect(screen.getByTestId("match-preview")).toBeTruthy());
    // "Back" returns to choosing; closing the dialog leaves everything as it was.
    fireEvent.click(screen.getByTestId("match-preview-back"));
    await waitFor(() => expect(screen.getByTestId("match-choose")).toBeTruthy());
    fireEvent.click(screen.getByTestId("work-match-close"));
    expect(closed).toEqual(["closed"]);
    expect(second.of("metadata.link")).toHaveLength(0);
    expect(second.of("metadata.refresh")).toHaveLength(0);
  });

  it("starts a refresh straight at the preview of the linked entry, and applies it as a refresh", async () => {
    const host = installHost({
      "metadata.preview": () => ({ ...preview(), mode: "refresh" }),
      "metadata.refresh": () => ({}),
    });
    mount({ refresh: true, detail: detail({ linked: true, linkedSource: { providerId: "bangumi", externalId: "42", namespace: "subject", fetchedAt: "2026-10-01T00:00:00.000Z", detached: false, sourceUrl: null, rating: null, episodeCount: 0, relatedCount: 0 } }) });
    await waitFor(() => expect(screen.getByTestId("match-preview").getAttribute("data-mode")).toBe("refresh"));
    expect(host.of("metadata.preview")[0]!.input).toMatchObject({ externalId: "42" });
    fireEvent.click(screen.getByTestId("match-apply"));
    await waitFor(() => expect(host.of("metadata.refresh")).toHaveLength(1));
    expect(host.of("metadata.refresh")[0]!.input).toMatchObject({ workId: "wc", providerId: "bangumi" });
    expect(host.of("metadata.link")).toHaveLength(0);
  });

  it("says a search failed instead of showing it as empty, and says a result is empty when it is", async () => {
    let mode: "fail" | "empty" = "fail";
    installHost({
      "metadata.candidates": () => ({ candidates: [] }),
      "metadata.search": () => {
        if (mode === "fail") throw fail("PROVIDER_UNAVAILABLE", "offline");
        return { searchId: "s1", results: [], failures: [], partial: false, searchedAt: "2026-10-01T00:00:00.000Z" };
      },
    });
    mount();
    fireEvent.click(screen.getByTestId("match-search"));
    await waitFor(() => expect(screen.getByTestId("match-failed").textContent).toContain(t("match.offline")));
    expect(screen.queryByTestId("match-empty")).toBeNull();
    mode = "empty";
    fireEvent.click(screen.getByTestId("match-search"));
    await waitFor(() => expect(screen.getByTestId("match-empty")).toBeTruthy());
  });
});

// ---- note bubbles: four sources and the jump back ----------------------------------------------------------

describe("notes in the message list: four kinds of source (A-48)", () => {
  const note = (id: string, patch: Partial<StreamNote> = {}): StreamNote => ({
    kind: "note", id, at: "2026-10-01T08:00:00.000Z", title: id, text: `笔记 ${id}`, quote: "", tags: [], revision: 1, resourceId: "res_1", resourceRevisionId: "rev_1", anchorId: "a", locator: null, pageNumber: null, ...patch,
  });
  const selection = note("sel", { quote: "被选中的句子", locator: { kind: "text", partId: "part1", representationId: "rep", normalizationVersion: "v1", range: { start: 10, end: 16 }, quote: { exact: "被选中的句子" } } as never });
  const region = note("reg", { pageNumber: 3, locator: { kind: "image", pageId: "p2", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } } as never });
  const interval = note("int", { locator: { kind: "temporal", startMs: 30_000, endMs: 40_000 } as never });
  const plain = note("plain", { resourceId: null, resourceRevisionId: null, anchorId: null, locator: null });
  const actions = (jumps: StreamNote[]): BubbleActions => ({
    onJumpNote: (item) => jumps.push(item), onJumpVoice: () => undefined, onEditNote: async () => true, onDeleteNote: async () => undefined, onQuoteNote: () => undefined, onOpenRecording: () => undefined, onRetry: () => undefined,
  });

  it("labels each source as what it is, and jumps from the three that point somewhere", () => {
    const jumps: StreamNote[] = [];
    render(<MessageList t={t} items={[selection, region, interval, plain]} hasMore={false} onOlder={() => undefined} actions={actions(jumps)} empty={null} formatDate={i18n.formatDate} />);
    expect(screen.getByTestId("bubble-quote-sel").textContent).toBe("被选中的句子");
    expect(screen.getByTestId("bubble-source-reg").textContent).toContain("3");
    expect(screen.getByTestId("bubble-source-int").textContent).toContain("0:30");
    // A note with no source is not a button.
    expect(screen.getByTestId("bubble-source-plain").tagName).toBe("SPAN");
    for (const id of ["sel", "reg", "int"]) expect(screen.getByTestId(`bubble-source-${id}`).tagName).toBe("BUTTON");
    fireEvent.click(screen.getByTestId("bubble-source-sel"));
    fireEvent.click(screen.getByTestId("bubble-source-reg"));
    fireEvent.click(screen.getByTestId("bubble-source-int"));
    expect(jumps.map((item) => item.id)).toEqual(["sel", "reg", "int"]);
    expect(jumps[0]!.locator).toMatchObject({ kind: "text", range: { start: 10, end: 16 } });
    expect(jumps[1]!.locator).toMatchObject({ kind: "image", pageId: "p2", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });
    expect(jumps[2]!.locator).toMatchObject({ kind: "temporal", startMs: 30_000, endMs: 40_000 });
  });

  it("edits, quotes and deletes a note from its bubble, asking before it deletes", async () => {
    const edits: Array<[string, string]> = [];
    const deletes: string[] = [];
    const quotes: string[] = [];
    render(
      <MessageList t={t} items={[plain]} hasMore={false} onOlder={() => undefined} empty={null} formatDate={i18n.formatDate}
        actions={{ ...actions([]), onEditNote: async (item, text) => { edits.push([item.id, text]); return true; }, onDeleteNote: async (item) => { deletes.push(item.id); }, onQuoteNote: (item) => quotes.push(item.id) }} />,
    );
    fireEvent.click(screen.getByTestId("bubble-edit-open-plain"));
    fireEvent.change(screen.getByTestId("bubble-edit-plain"), { target: { value: "改过的笔记" } });
    fireEvent.click(screen.getByTestId("bubble-save-plain"));
    await waitFor(() => expect(edits).toEqual([["plain", "改过的笔记"]]));
    await waitFor(() => expect(screen.queryByTestId("bubble-edit-plain")).toBeNull());
    fireEvent.click(screen.getByTestId("bubble-quote-ask-plain"));
    expect(quotes).toEqual(["plain"]);
    fireEvent.click(screen.getByTestId("bubble-delete-plain"));
    expect(deletes).toEqual([]);
    expect(screen.getByTestId("bubble-confirm-plain")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bubble-delete-confirm-plain"));
    await waitFor(() => expect(deletes).toEqual(["plain"]));
  });

  describe("in the app", () => {
    let media: ReturnType<typeof installMediaElement>;
    beforeEach(() => { media = installMediaElement(); resetVideoSupport(); });
    afterEach(() => { media.restore(); });

    const comicWork = { id: "wc", title: "合成漫画", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: { id: "res_c1", title: "合成漫画", ordinalLabel: null, revisionId: "rev_res_c1" }, progress: 0.2, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null };
    const comicHost = (items: unknown[]) => installHost({
      "works.list": (input) => ({ items: !input.kind || input.kind === "comic" ? [comicWork] : [], total: 1, nextCursor: null }),
      "works.get": () => ({ ...comicWork, originalTitle: "合成漫画", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [{ id: "res_c1", title: "漫画一", kind: "comic", ordinalLabel: "第 1 话", available: true }] }),
      "progress.get": () => ({ locator: null, completion: "new" }),
      "comic.pages": (input) => ({
        resourceId: input.resourceId, revisionId: "rev_res_c1", title: "合成漫画", direction: null, available: true, warnings: [],
        pages: Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
      }),
      "comic.pageHandles": (input) => ({ pages: (input.pageIds as string[]).map((pageId) => ({ pageId, available: true, kind: "image", url: `manga-media://h/${pageId}`, handle: pageId, mediaType: "image/png", width: 800, height: 1200 })) }),
      "settings.getMedia": () => ({}),
      "session.stream": () => ({ items, hasMore: false, session: { id: "ses", kind: "shared", targetId: null, workId: null, resourceId: null } }),
    });

    it("opens the comic page of a region note and leaves the reader back to where it was", async () => {
      comicHost([region]);
      render(<App />);
      await waitFor(() => expect(screen.getByTestId("shell-right")).toBeTruthy());
      const pane = () => within(screen.getByTestId("shell-right"));
      await waitFor(() => expect(pane().getByTestId("bubble-source-reg")).toBeTruthy());
      fireEvent.click(pane().getByTestId("bubble-source-reg"));
      await waitFor(() => expect(screen.getByTestId("comic-reader")).toBeTruthy());
      await waitFor(() => expect(screen.getByTestId("comic-position").textContent).toContain("3 / 6"));
      fireEvent.click(screen.getByTestId("comic-back"));
      await waitFor(() => expect(screen.queryByTestId("comic-reader")).toBeNull());
    });
  });
});

// ---- the capsule ------------------------------------------------------------------------------------------

describe("the floating capsule: the same note and microphone as the pane (A-47)", () => {
  const idle = { phase: "idle", elapsedMs: 0 } as never;
  const mic = (patch: Record<string, unknown> = {}) => ({ t, state: idle, enabled: true, toggleKey: "F8", onToggle: () => undefined, onHoldStart: () => undefined, onHoldEnd: () => undefined, onStop: () => undefined, ...patch }) as never;

  it("writes a note from a small box and closes it once the note is saved", async () => {
    const notes: string[] = [];
    render(<Capsule t={t} mic={null} onNote={async (text) => { notes.push(text); return true; }} />);
    expect(screen.queryByTestId("capsule-note-box")).toBeNull();
    fireEvent.click(screen.getByTestId("capsule-note"));
    expect(screen.getByTestId("capsule-note-box")).toBeTruthy();
    expect((screen.getByTestId("capsule-note-send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("capsule-note-input"), { target: { value: "胶囊里写的笔记" } });
    fireEvent.keyDown(screen.getByTestId("capsule-note-input"), { key: "Enter" });
    await waitFor(() => expect(notes).toEqual(["胶囊里写的笔记"]));
    await waitFor(() => expect(screen.queryByTestId("capsule-note-box")).toBeNull());
    fireEvent.click(screen.getByTestId("capsule-note"));
    expect((screen.getByTestId("capsule-note-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps the text when the note could not be saved, and does not send while composing", async () => {
    const notes: string[] = [];
    render(<Capsule t={t} mic={null} onNote={async (text) => { notes.push(text); return false; }} />);
    fireEvent.click(screen.getByTestId("capsule-note"));
    const input = screen.getByTestId("capsule-note-input");
    fireEvent.change(input, { target: { value: "还没写完" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(notes).toEqual([]);
    expect(screen.getByTestId("capsule-note-box")).toBeTruthy();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(notes).toEqual([]);
    fireEvent.click(screen.getByTestId("capsule-note-send"));
    await waitFor(() => expect(notes).toEqual(["还没写完"]));
    expect((screen.getByTestId("capsule-note-input") as HTMLTextAreaElement).value).toBe("还没写完");
    fireEvent.keyDown(screen.getByTestId("capsule-note-input"), { key: "Escape" });
    expect(screen.queryByTestId("capsule-note-box")).toBeNull();
  });

  it("lets a tag alone make a note, and shows the tag it will anchor to", async () => {
    const notes: string[] = [];
    render(<Capsule t={t} mic={null} tagLabel="0:10—0:20" onNote={async (text) => { notes.push(text); return true; }} />);
    fireEvent.click(screen.getByTestId("capsule-note"));
    expect(screen.getByTestId("capsule-tag").textContent).toContain("0:10—0:20");
    fireEvent.click(screen.getByTestId("capsule-note-send"));
    await waitFor(() => expect(notes).toEqual([""]));
  });

  it("has the microphone only when the voice module gives one, and starts a recording with it", () => {
    const toggles: string[] = [];
    const view = render(<Capsule t={t} mic={null} onNote={async () => true} />);
    expect(screen.queryByTestId("chat-mic")).toBeNull();
    view.unmount();
    render(<Capsule t={t} mic={mic({ onToggle: () => toggles.push("toggle") })} onNote={async () => true} />);
    const button = screen.getByTestId("chat-mic");
    expect(button.getAttribute("aria-label")).toContain("F8");
    // A keyboard press arrives as a click with no pointer detail.
    fireEvent.click(button, { detail: 0 });
    expect(toggles).toEqual(["toggle"]);
  });

  it("shows the elapsed time while recording and stops with the same button", () => {
    const stops: string[] = [];
    render(<Capsule t={t} mic={mic({ state: { phase: "recording", elapsedMs: 65_000 }, onStop: () => stops.push("stop") })} onNote={async () => true} />);
    expect(screen.getByTestId("chat-mic-time").textContent).toBe("1:05");
    expect(screen.getByTestId("chat-mic").getAttribute("data-phase")).toBe("recording");
    fireEvent.click(screen.getByTestId("chat-mic"), { detail: 0 });
    expect(stops).toEqual(["stop"]);
  });
  it("has no note button where a note would belong to nothing", () => {
    render(<Capsule t={t} mic={mic()} />);
    expect(screen.getByTestId("chat-mic")).toBeTruthy();
    expect(screen.queryByTestId("capsule-note")).toBeNull();
  });
});

describe("where a note can be written: a resource or a work, never nowhere (A-48)", () => {
  const work = { id: "wc", title: "合成漫画", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: { id: "res_c1", title: "合成漫画", ordinalLabel: null, revisionId: "rev" }, progress: 0, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null };
  const host = () => installHost({
    "works.list": (input) => ({ items: !input.kind || input.kind === "comic" ? [work] : [], total: 1, nextCursor: null }),
    "works.get": () => ({ ...work, originalTitle: "合成漫画", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [{ id: "res_c1", title: "漫画一", kind: "comic", ordinalLabel: "第 1 话", available: true }] }),
    "progress.get": () => ({ locator: null, completion: "new" }),
    "agent.send": (input) => ({ runId: "run-1", id: "run-1", status: "running", sessionId: "ses_shared", inputText: String(input.text ?? ""), messages: [] }),
  });

  it("asks the Agent from a shelf even when the last choice was a note, and offers the note again on the work's page", async () => {
    window.localStorage.setItem("manga.chat.mode", "note");
    const calls = host();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-comic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("shelf-comic")).toBeTruthy());
    const pane = () => within(screen.getByTestId("shell-right"));
    await waitFor(() => expect(pane().getByTestId("agent-composer")).toBeTruthy());
    expect(pane().queryByTestId("chat-mode-note")).toBeNull();
    expect(pane().getByTestId("agent-send").getAttribute("aria-label")).toBe(t("agent.send"));
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "书架上问一句" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(calls.of("agent.send").map((call) => call.input.text)).toEqual(["书架上问一句"]));
    expect(calls.of("notes.create")).toEqual([]);
    // The remembered choice was left alone: on the work's own page a note is what the input writes again.
    expect(window.localStorage.getItem("manga.chat.mode")).toBe("note");
    fireEvent.click(screen.getByTestId("open-res_c1"));
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    await waitFor(() => expect(pane().getByTestId("chat-mode-note").getAttribute("aria-pressed")).toBe("true"));
    expect(pane().getByTestId("agent-send").getAttribute("aria-label")).toBe(t("chat.send.note"));
  });
});

describe("the left rail follows the place a resource was left (A-47)", () => {
  it("shows the page a comic was left at once the reader closes, even when the last page was written as it closed", async () => {
    let saved = 0;
    const pageIds = Array.from({ length: 6 }, (_, index) => `p${index}`);
    const work = { id: "wc", title: "合成漫画", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: { id: "res_c1", title: "合成漫画", ordinalLabel: null, revisionId: "rev_res_c1" }, progress: 0, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null };
    installHost({
      "workspace.sessions": () => [
        { sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null },
        { sessionId: "ses_resource_res_c1", title: "合成漫画", kind: "resource", targetId: "res_c1", workId: "wc", mediaKind: "comic", mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null, ordinalLabel: null, progress: { percent: (saved + 1) / 6, locator: { kind: "image", pageId: pageIds[saved] }, unit: "page", total: 6 } },
      ],
      "works.list": (input) => ({ items: !input.kind || input.kind === "comic" ? [work] : [], total: 1, nextCursor: null }),
      "works.get": () => ({ ...work, originalTitle: "合成漫画", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [{ id: "res_c1", title: "漫画一", kind: "comic", ordinalLabel: null, available: true }] }),
      "progress.get": () => ({ locator: null, completion: "new" }),
      "progress.setPage": (input) => { saved = pageIds.indexOf(String(input.pageId)); return {}; },
      "comic.pages": (input) => ({ resourceId: input.resourceId, revisionId: "rev_res_c1", title: "合成漫画", direction: null, available: true, warnings: [], pages: pageIds.map((id, index) => ({ id, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })) }),
      "comic.pageHandles": (input) => ({ pages: (input.pageIds as string[]).map((pageId) => ({ pageId, available: true, kind: "image", url: `manga-media://h/${pageId}`, handle: pageId, mediaType: "image/png", width: 800, height: 1200 })) }),
      "settings.getMedia": () => ({}),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-comic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("session-position-ses_resource_res_c1").textContent).toBe("1/6"));
    fireEvent.click(screen.getByTestId("open-res_c1"));
    await waitFor(() => expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(screen.getByTestId("comic-position").textContent).toContain("1 / 6"));
    fireEvent.click(screen.getByTestId("comic-next"));
    fireEvent.click(screen.getByTestId("comic-next"));
    await waitFor(() => expect(screen.getByTestId("comic-position").textContent).toContain("3 / 6"));
    // Straight back to the shelf: page 3 has not been written yet, so it is written as the reader closes.
    fireEvent.click(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.queryByTestId("comic-reader")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("session-position-ses_resource_res_c1").textContent).toBe("3/6"));
    expect(saved).toBe(2);
  });
});

// ---- the debug panel --------------------------------------------------------------------------------------

describe("the debug panel: what the next task is given, and nothing secret (A-48)", () => {
  const secretKey = ["sk", "-", "A".repeat(24)].join("");
  const dataUrl = `data:image/png;base64,${"A".repeat(900)}`;
  const mountPanel = (view: Partial<DebugView> = {}, overrides: { onView?: (view: DebugView) => void; live?: Record<string, unknown>; events?: Array<{ at: string; topic: string; payload: unknown }>; onNotice?: (message: string) => void } = {}) => render(
    <DebugPanel
      t={t}
      view={{ ...DEFAULT_DEBUG_VIEW, open: true, ...view }}
      onView={overrides.onView ?? (() => undefined)}
      scope={{ sessionId: "ses_1", resourceId: "res_1", page: "comic" }}
      live={overrides.live ?? { page: "comic", position: "第 3/6 页", apiKey: secretKey, image: dataUrl }}
      events={overrides.events ?? []}
      version={0}
      onNotice={overrides.onNotice ?? (() => undefined)}
    />,
  );
  const report = (lastRun: unknown) => ({
    generatedAt: "2026-10-01T08:00:00.000Z", scope: { resourceId: "res_1" }, model: { id: "m1", name: "合成模型" }, tools: [{ id: "library.search", description: "x" }], budget: { chars: 1000 }, lastRun,
  });

  it("asks the host once for the scope, shows the live values with credentials and pictures hidden, and does nothing when closed", async () => {
    const host = installHost({ "debug.context": () => report(null) });
    const closed = mountPanel({ open: false });
    expect(closed.container.firstChild).toBeNull();
    expect(host.of("debug.context")).toHaveLength(0);
    closed.unmount();
    mountPanel();
    await waitFor(() => expect(screen.getByTestId("debug-model")).toBeTruthy());
    expect(host.of("debug.context")[0]!.input).toEqual({ sessionId: "ses_1", resourceId: "res_1", page: "comic" });
    const body = screen.getByTestId("debug-body-current").textContent ?? "";
    expect(body).toContain("第 3/6 页");
    expect(body).toContain("library.search");
    expect(body).not.toContain(secretKey);
    expect(body).toContain("[已隐去]");
    // A picture is shown by size and hash, never as its bytes.
    expect(body).not.toContain("AAAAAAAAAA");
    expect(body).toMatch(/\[图像 \d+ 字符 #[0-9a-f]{8}\]/);
  });

  it("shows what the last task was given, or says no task has run", async () => {
    const lastRun = { runId: "run_1", status: "completed", question: "这一页讲了什么", materials: [{ id: "mat_1" }], notes: [], history: { turns: 2 }, modelId: "m1", inputTokens: 120, outputTokens: 30, contextText: "当前页文字" };
    installHost({ "debug.context": () => report(lastRun) });
    mountPanel({ tab: "last" });
    await waitFor(() => expect(screen.getByTestId("debug-last")).toBeTruthy());
    const text = screen.getByTestId("debug-last").textContent ?? "";
    expect(text).toContain("这一页讲了什么");
    expect(text).toContain("run_1");
    expect(text).toContain("120 / 30");
    expect(text).toContain("当前页文字");
    cleanup();
    installHost({ "debug.context": () => report(null) });
    mountPanel({ tab: "last" });
    await waitFor(() => expect(screen.getByTestId("debug-last-none")).toBeTruthy());
  });

  it("lists the latest events newest first with their payloads redacted", async () => {
    installHost({ "debug.context": () => report(null) });
    mountPanel({ tab: "events" }, { events: [
      { at: "2026-10-01T08:00:01.000Z", topic: "capture.changed", payload: { id: "cap_1" } },
      { at: "2026-10-01T08:00:02.000Z", topic: "run.changed", payload: { token: "abcdef", note: "保留" } },
    ] });
    await waitFor(() => expect(screen.getByTestId("debug-events")).toBeTruthy());
    const rows = [...screen.getByTestId("debug-events").querySelectorAll("li")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("run.changed");
    expect(rows[1]).toContain("capture.changed");
    expect(rows[0]).not.toContain("abcdef");
    expect(rows[0]).toContain("保留");
  });

  it("copies one redacted document, and says so when copying is refused", async () => {
    installHost({ "debug.context": () => report({ runId: "run_1", status: "completed", question: "问题", contextText: `Bearer ${"x".repeat(20)}` }) });
    const written: string[] = [];
    const notices: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
    mountPanel({}, { onNotice: (message) => notices.push(message) });
    await waitFor(() => expect(screen.getByTestId("debug-model")).toBeTruthy());
    fireEvent.click(screen.getByTestId("debug-copy"));
    await waitFor(() => expect(written).toHaveLength(1));
    const document = JSON.parse(written[0]!) as { page: string; lastRun: { question: string; contextText: string }; current: Record<string, unknown> };
    expect(document.page).toBe("comic");
    expect(document.lastRun.question).toBe("问题");
    expect(written[0]).not.toContain(secretKey);
    expect(written[0]).not.toContain("x".repeat(20));
    expect(document.current.apiKey).toBe("[已隐去]");
    expect(notices).toEqual([t("debug.copied")]);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
    fireEvent.click(screen.getByTestId("debug-copy"));
    await waitFor(() => expect(notices).toEqual([t("debug.copied"), t("debug.copyFailed")]));
  });

  it("switches tabs, closes, and is resized with the keyboard within its limits", async () => {
    installHost({ "debug.context": () => report(null) });
    const views: DebugView[] = [];
    mountPanel({}, { onView: (view) => views.push(view) });
    fireEvent.click(screen.getByTestId("debug-tab-events"));
    expect(views.at(-1)).toMatchObject({ tab: "events", open: true });
    fireEvent.keyDown(screen.getByTestId("debug-grip"), { key: "ArrowUp" });
    expect(views.at(-1)!.height).toBe(DEFAULT_DEBUG_VIEW.height + 24);
    cleanup();
    mountPanel({ height: 130 }, { onView: (view) => views.push(view) });
    fireEvent.keyDown(screen.getByTestId("debug-grip"), { key: "ArrowDown" });
    expect(views.at(-1)!.height).toBe(120);
    fireEvent.click(screen.getByTestId("debug-close"));
    expect(views.at(-1)!.open).toBe(false);
  });
});

// ---- settings: pages, quick tasks, records ----------------------------------------------------------------

const quickList = (): QuickTask[] => BUILTIN_QUICK_TASKS.slice(0, 3).map((task, order) => ({ ...task, id: `qt_${task.builtinKey}`, builtin: true, enabled: true, order }) as QuickTask);

describe("settings pages inside the app (A-49, A-52)", () => {
  const shelfHost = (handlers: Record<string, Handler> = {}) => installHost({
    "works.list": (input) => ({ items: input.kind === "comic" || !input.kind ? [{ id: "wc", title: "合成漫画", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: { id: "res_c1", title: "合成漫画", ordinalLabel: null, revisionId: "rev" }, progress: 0, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null }] : [], total: 1, nextCursor: null }),
    "quickTasks.list": () => ({ tasks: quickList() }),
    ...handlers,
  });

  it("opens settings from a shelf, reaches the quick-task page, and goes back to the same shelf", async () => {
    shelfHost();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-comic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("shelf-comic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    expect(screen.queryByTestId("nav-comic")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-nav-quick"));
    await waitFor(() => expect(screen.getByTestId("quick-task-summarize-page")).toBeTruthy());
    expect(screen.getByTestId("settings-nav-quick").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("settings-back"));
    await waitFor(() => expect(screen.getByTestId("shelf-comic")).toBeTruthy());
    expect(screen.queryByTestId("settings-nav")).toBeNull();
  });

  it("checks a quick task's wording before it can be saved, and sends what was written", async () => {
    const host = shelfHost({ "quickTasks.save": () => ({ id: "qt_new" }) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-settings")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav-quick")).toBeTruthy());
    fireEvent.click(screen.getByTestId("settings-nav-quick"));
    await waitFor(() => expect(screen.getByTestId("quick-new")).toBeTruthy());
    fireEvent.click(screen.getByTestId("quick-new"));
    const save = () => screen.getByTestId("quick-save") as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(screen.getByTestId("quick-error").textContent).toBe(t("quick.errName"));
    fireEvent.change(screen.getByTestId("quick-name"), { target: { value: "我的任务" } });
    expect(screen.getByTestId("quick-error").textContent).toBe(t("quick.errTemplate"));
    fireEvent.change(screen.getByTestId("quick-template"), { target: { value: "请说说{不存在的位置}" } });
    expect(screen.getByTestId("quick-error").textContent).toContain("不存在的位置");
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("quick-template"), { target: { value: "请说说《{作品}》{当前位置}" } });
    expect(screen.queryByTestId("quick-error")).toBeNull();
    for (const page of ["library", "work", "novel", "comic", "video", "chat"]) fireEvent.click(screen.getByTestId(`quick-page-${page}`));
    expect(screen.getByTestId("quick-error").textContent).toBe(t("quick.errPages"));
    fireEvent.click(screen.getByTestId("quick-page-comic"));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(host.of("quickTasks.save")).toHaveLength(1));
    expect(host.of("quickTasks.save")[0]!.input).toEqual({ name: "我的任务", template: "请说说《{作品}》{当前位置}", pages: ["comic"], includeFrame: false, sendMode: "send", enabled: true });
  });

  it("states every reason a draft cannot be saved, and accepts a good one", () => {
    const good = { name: "n", template: "{作品}", pages: ["comic"] as never, includeFrame: false, sendMode: "send" as const, enabled: true };
    expect(draftProblem(t, good)).toBeNull();
    expect(draftProblem(t, { ...good, name: "  " })).toBe(t("quick.errName"));
    expect(draftProblem(t, { ...good, template: "" })).toBe(t("quick.errTemplate"));
    expect(draftProblem(t, { ...good, template: "{甲}{乙}" })).toBe(t("quick.errUnknown", { names: "甲、乙" }));
    expect(draftProblem(t, { ...good, pages: [] })).toBe(t("quick.errPages"));
  });

  it("asks the records list for exactly the filters chosen, pages in the host, and restores a deleted note", async () => {
    const record = (id: string, patch: Record<string, unknown> = {}) => ({ kind: "note", id, title: `笔记 ${id}`, preview: "", at: "2026-10-01T08:00:00.000Z", deleted: false, workId: "wc", workTitle: "合成漫画", mediaKind: "comic", resourceId: "res_c1", resourceTitle: "合成漫画", tags: [], stage: null, audioState: null, durationMs: null, hasSource: false, ...patch });
    const host = shelfHost({
      "records.list": (input) => ({ total: input.deleted ? 1 : 2, items: input.deleted ? [record("n_gone", { deleted: true })] : [record("n1"), record("n2")] }),
      "notes.undelete": () => ({}),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-settings")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav-records")).toBeTruthy());
    fireEvent.click(screen.getByTestId("settings-nav-records"));
    await waitFor(() => expect(screen.getByTestId("record-n1")).toBeTruthy());
    const last = () => host.of("records.list").at(-1)!.input;
    expect(last()).toEqual({ type: "all", limit: 30, offset: 0 });
    fireEvent.change(screen.getByTestId("records-kind"), { target: { value: "comic" } });
    await waitFor(() => expect(last()).toMatchObject({ mediaKind: "comic" }));
    // Choosing a recording state means recordings.
    fireEvent.change(screen.getByTestId("records-state"), { target: { value: "failed" } });
    await waitFor(() => expect(last()).toMatchObject({ type: "recording", state: "failed", mediaKind: "comic" }));
    fireEvent.change(screen.getByTestId("records-state"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("records-type"), { target: { value: "note" } });
    await waitFor(() => expect(last()).toMatchObject({ type: "note" }));
    expect((screen.getByTestId("records-state") as HTMLSelectElement).disabled).toBe(true);
    // Typing waits a moment, then asks once with the text.
    const before = host.of("records.list").length;
    fireEvent.change(screen.getByTestId("records-search"), { target: { value: "合成" } });
    await waitFor(() => expect(last()).toMatchObject({ q: "合成", offset: 0 }));
    expect(host.of("records.list").length).toBe(before + 1);
    // The deleted view lists hidden notes and brings one back.
    fireEvent.click(screen.getByTestId("records-deleted"));
    await waitFor(() => expect(screen.getByTestId("record-n_gone")).toBeTruthy());
    expect(last()).toMatchObject({ deleted: true, type: "note" });
    expect(screen.getByTestId("record-n_gone").getAttribute("data-deleted")).toBe("true");
    fireEvent.click(screen.getByTestId("record-restore-n_gone"));
    await waitFor(() => expect(host.of("notes.undelete")).toHaveLength(1));
    expect(host.of("notes.undelete")[0]!.input).toEqual({ objectId: "n_gone" });
  });

  it("returns from a note to the page it was opened from: the work's records, or the records list", async () => {
    shelfHost({
      "works.get": () => ({ id: "wc", title: "合成漫画", originalTitle: "合成漫画", author: "合成作者", mediaKind: "comic", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [{ id: "res_c1", title: "漫画一", kind: "comic", ordinalLabel: null, available: true }] }),
      "notes.list": (input) => (input.resourceId === "res_c1" ? [{ objectId: "obj_n1", title: "作品里的笔记", preview: "正文" }] : []),
      "notes.get": () => ({ objectId: "obj_n1", revision: 1, title: "作品里的笔记", tags: [], document: { blocks: [] } }),
      "records.list": () => ({ items: [{ kind: "note", id: "obj_n1", title: "作品里的笔记", preview: "正文", at: "2026-01-01T00:00:00.000Z", deleted: false, workId: "wc", workTitle: "合成漫画", mediaKind: "comic", resourceId: "res_c1", resourceTitle: "漫画一", tags: [], stage: null, audioState: null, durationMs: null, hasSource: false }], total: 1 }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-comic")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.getByTestId("open-res_c1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("open-res_c1"));
    await waitFor(() => expect(screen.getByTestId("detail-tab-records")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-tab-records"));
    await waitFor(() => expect(screen.getByTestId("detail-note-obj_n1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-note-obj_n1"));
    await waitFor(() => expect(screen.getByTestId("note-back")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-back"));
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    expect(screen.queryByTestId("settings-nav")).toBeNull();

    // From the records list in settings, back is the records list.
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav-records")).toBeTruthy());
    fireEvent.click(screen.getByTestId("settings-nav-records"));
    await waitFor(() => expect(screen.getByTestId("record-open-obj_n1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("record-open-obj_n1"));
    await waitFor(() => expect(screen.getByTestId("note-back")).toBeTruthy());
    fireEvent.click(screen.getByTestId("note-back"));
    await waitFor(() => expect(screen.getByTestId("record-open-obj_n1")).toBeTruthy());
    expect(screen.getByTestId("settings-nav-records").getAttribute("aria-current")).toBe("page");
  });

  it("leaves the pages that need a module out of the navigation, and keeps modules, records and logs reachable", async () => {
    shelfHost({ "workspace.get": () => ({ uiFacets: ["library", "settings", "comic"], sessions: [], runs: [], notes: [], resources: [] }) });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-settings")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    for (const page of ["general", "library", "modules", "records", "logs"]) expect(screen.getByTestId(`settings-nav-${page}`)).toBeTruthy();
    for (const page of ["models", "quick", "usage", "recording", "sources"]) expect(screen.queryByTestId(`settings-nav-${page}`)).toBeNull();
  });
});
