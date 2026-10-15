/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { VoicePage } from "../../apps/desktop/src/renderer/pages/settings/voice-page.tsx";
import { DEFAULT_RECORDING_SETTINGS, type RecordingPatch, type RecordingSettings } from "../../apps/desktop/src/renderer/voice/use-recorder.ts";

const i18n = createTranslator("zh-CN");

type Call = { commandId: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;

function installHost(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed" } };
      }
    },
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

const transcription = (id: string, label: string) => ({ id, label, modelId: "whisper-1", purpose: "transcription", protocol: "openai-audio" });

function Harness(props: { connections?: unknown[]; initial?: Partial<RecordingSettings>; saved: RecordingPatch[]; onError?: (message: string) => void; onNotice?: (message: string) => void; onGoto?: () => void }) {
  const [settings, setSettings] = useState<RecordingSettings>({ ...DEFAULT_RECORDING_SETTINGS, ...props.initial });
  return (
    <VoicePage
      t={i18n.t}
      settings={{ connections: props.connections ?? [] }}
      recording={{
        settings,
        save: async (patch) => {
          props.saved.push(patch);
          const { promptCharsByConnection, ...rest } = patch;
          setSettings((current) => {
            const merged = { ...current.promptCharsByConnection };
            for (const [id, value] of Object.entries(promptCharsByConnection ?? {})) { if (value === null) delete merged[id]; else merged[id] = value; }
            return { ...current, ...rest, promptCharsByConnection: merged };
          });
        },
      }}
      onGoto={props.onGoto ?? (() => undefined)}
      onError={props.onError ?? (() => undefined)}
      onNotice={props.onNotice ?? (() => undefined)}
    />
  );
}

const prompt = (patch: Record<string, unknown> = {}) => ({ text: "", included: [], total: 0, cut: 0, limit: 600, connectionId: null, language: null, ...patch });
const term = (id: string, text: string, source = "manual", extra: Record<string, unknown> = {}) => ({ id, scope: "global", workId: null, term: text, heard: null, source, auto: source !== "manual", ...extra });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the voice transcription settings page (AT-76)", () => {
  it("says there is no transcription connection and points to where one is added", async () => {
    installHost({ "dictionary.prompt": () => prompt(), "dictionary.list": () => ({ terms: [] }) });
    const goto = vi.fn();
    render(<Harness saved={[]} onGoto={goto} />);
    expect(screen.getByTestId("voice-connection-none").textContent).toContain("还没有转录连接");
    fireEvent.click(screen.getByTestId("voice-goto-models"));
    expect(goto).toHaveBeenCalled();
    // The text model is not offered for recordings: only transcription connections are listed.
    render(<Harness saved={[]} connections={[{ id: "t1", label: "文本模型", purpose: "text" }]} />);
    expect(screen.queryByTestId("voice-connection-t1")).toBeNull();
  });

  it("lists the transcription connections, marks the one in use, and sets a hint length for one connection or takes it back", async () => {
    const host = installHost({ "dictionary.prompt": () => prompt(), "dictionary.list": () => ({ terms: [] }) });
    const saved: RecordingPatch[] = [];
    render(<Harness saved={saved} connections={[transcription("c1", "转录甲"), transcription("c2", "转录乙")]} />);
    expect(screen.getByTestId("voice-connection-c1").textContent).toContain("当前使用");
    expect(screen.getByTestId("voice-connection-c2").textContent).not.toContain("当前使用");
    const input = screen.getByTestId("voice-limit-c2") as HTMLInputElement;
    expect(input.placeholder).toBe("600");
    fireEvent.change(input, { target: { value: "120" } });
    expect(saved.at(-1)).toEqual({ promptCharsByConnection: { c2: 120 } });
    expect((screen.getByTestId("voice-limit-c2") as HTMLInputElement).value).toBe("120");
    // A value outside what the model protocol accepts is brought into range instead of being sent as it is.
    fireEvent.change(screen.getByTestId("voice-limit-c2"), { target: { value: "9" } });
    expect(saved.at(-1)).toEqual({ promptCharsByConnection: { c2: 50 } });
    fireEvent.change(screen.getByTestId("voice-limit-c2"), { target: { value: "" } });
    expect(saved.at(-1)).toEqual({ promptCharsByConnection: { c2: null } });
    await waitFor(() => expect((screen.getByTestId("voice-limit-c2") as HTMLInputElement).value).toBe(""));
    expect(host.of("dictionary.prompt").length).toBeGreaterThan(0);
  });

  it("saves the language and the general hint length", async () => {
    installHost({ "dictionary.prompt": () => prompt(), "dictionary.list": () => ({ terms: [] }) });
    const saved: RecordingPatch[] = [];
    render(<Harness saved={saved} />);
    fireEvent.change(screen.getByTestId("voice-language"), { target: { value: "ja" } });
    expect(saved.at(-1)).toEqual({ language: "ja" });
    fireEvent.change(screen.getByTestId("voice-language"), { target: { value: "" } });
    expect(saved.at(-1)).toEqual({ language: null });
    fireEvent.change(screen.getByTestId("voice-prompt-chars"), { target: { value: "900" } });
    expect(saved.at(-1)).toEqual({ promptChars: 900 });
  });

  it("shows the hint that would be sent and says how many terms did not fit", async () => {
    let answer = prompt({ text: "甲, 乙", included: ["甲", "乙"], total: 5, cut: 3, limit: 50 });
    installHost({ "dictionary.prompt": () => answer, "dictionary.list": () => ({ terms: [] }) });
    render(<Harness saved={[]} />);
    await waitFor(() => expect(screen.getByTestId("voice-prompt-status").textContent).toContain("3 个词条没有放进提示"));
    expect(screen.getByTestId("voice-prompt-status").textContent).toContain("共 5 个，已放入 2 个");
    expect(screen.getByTestId("voice-prompt-text").textContent).toBe("甲, 乙");
    expect(screen.getByTestId("voice-prompt").getAttribute("data-cut")).toBe("3");
    cleanup();
    answer = prompt({ text: "甲, 乙", included: ["甲", "乙"], total: 2, cut: 0 });
    render(<Harness saved={[]} />);
    await waitFor(() => expect(screen.getByTestId("voice-prompt-status").textContent).toContain("2 个词条都在提示里"));
    cleanup();
    answer = prompt();
    render(<Harness saved={[]} />);
    await waitFor(() => expect(screen.getByTestId("voice-prompt-empty")).toBeTruthy());
  });

  it("adds, edits and deletes dictionary terms, and says which ones came from a linked source", async () => {
    let terms = [term("t1", "手写词条"), term("t2", "绫波丽", "metadata:bangumi:character:7")];
    const host = installHost({
      "dictionary.prompt": () => prompt(),
      "dictionary.list": () => ({ terms }),
      "dictionary.add": (input) => { terms = [...terms, term(`t${terms.length + 1}`, String(input.term), "manual", { heard: input.heard ?? null })]; return {}; },
      "dictionary.update": (input) => { terms = terms.map((item) => item.id === input.termId ? { ...item, term: String(input.term), heard: (input.heard as string | null) ?? null, source: "manual", auto: false } : item); return {}; },
      "dictionary.remove": (input) => { terms = terms.filter((item) => item.id !== input.termId); return {}; },
    });
    render(<Harness saved={[]} />);
    await waitFor(() => expect(screen.getByTestId("dictionary-term-t1")).toBeTruthy());
    expect(screen.getByTestId("dictionary-source-t1").textContent).toBe("手写");
    expect(screen.getByTestId("dictionary-source-t2").textContent).toBe("来自资料 · 角色");

    fireEvent.change(screen.getByTestId("dictionary-term"), { target: { value: "新词" } });
    fireEvent.change(screen.getByTestId("dictionary-heard"), { target: { value: "心此" } });
    fireEvent.click(screen.getByTestId("dictionary-add"));
    await waitFor(() => expect(screen.getByTestId("dictionary-term-t3")).toBeTruthy());
    expect(host.of("dictionary.add")[0]!.input).toEqual({ scope: "global", term: "新词", heard: "心此" });
    expect((screen.getByTestId("dictionary-term") as HTMLInputElement).value).toBe("");

    // Changing a term taken from a source keeps it: it becomes a hand-written one.
    fireEvent.click(screen.getByTestId("dictionary-edit-t2"));
    expect(screen.getByTestId("dictionary-term-t2").textContent).toContain("修改过的词条会被当作手写词条保留");
    fireEvent.change(screen.getByTestId("dictionary-edit-term"), { target: { value: "绫波 丽" } });
    fireEvent.click(screen.getByTestId("dictionary-edit-save"));
    await waitFor(() => expect(screen.getByTestId("dictionary-source-t2").textContent).toBe("手写"));
    expect(host.of("dictionary.update")[0]!.input).toEqual({ termId: "t2", term: "绫波 丽", heard: null });

    fireEvent.click(screen.getByTestId("dictionary-remove-t1"));
    await waitFor(() => expect(screen.queryByTestId("dictionary-term-t1")).toBeNull());
  });

  it("takes a work's names from its linked source, or says the work is not linked yet", async () => {
    const works = [{ id: "w1", title: "作品甲", mediaKind: "video" }, { id: "w2", title: "作品乙", mediaKind: "comic" }];
    let imported = false;
    const host = installHost({
      "works.list": () => ({ items: works, total: 2, nextCursor: null }),
      "dictionary.prompt": () => prompt(),
      "dictionary.list": (input) => ({ terms: input.workId === "w1" && imported ? [term("a1", "绫波丽", "metadata:bangumi:character:7", { scope: "work", workId: "w1", auto: true })] : [] }),
      "dictionary.importMetadata": (input) => {
        if (input.workId === "w2") throw Object.assign(new Error("link the work to a source before taking names from it"), { code: "VALIDATION_ERROR" });
        imported = true;
        return { workId: "w1", linked: true, added: 1, removed: 0, kept: 0, manualWins: 0 };
      },
    });
    const notices: string[] = [];
    const errors: string[] = [];
    render(<Harness saved={[]} onNotice={(message) => notices.push(message)} onError={(message) => errors.push(message)} />);
    fireEvent.click(screen.getByTestId("dictionary-scope-work"));
    expect(screen.getByTestId("dictionary-no-work")).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId("dictionary-work-select")).getAllByRole("option").length).toBe(3));
    fireEvent.change(screen.getByTestId("dictionary-work-select"), { target: { value: "w1" } });
    await waitFor(() => expect(screen.getByTestId("dictionary-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dictionary-import"));
    await waitFor(() => expect(notices.at(-1)).toBe("加入 1 个，移除 0 个，保留 0 个，手写词条优先 0 个"));
    await waitFor(() => expect(screen.getByTestId("dictionary-term-a1")).toBeTruthy());
    expect(host.of("dictionary.importMetadata")[0]!.input).toEqual({ workId: "w1" });
    // The hint preview follows the work chosen here.
    expect(host.of("dictionary.prompt").some((call) => call.input.workId === "w1")).toBe(true);

    fireEvent.change(screen.getByTestId("dictionary-work-select"), { target: { value: "w2" } });
    await waitFor(() => expect(screen.getByTestId("dictionary-import")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dictionary-import"));
    await waitFor(() => expect(errors.at(-1)).toBe("这部作品还没有关联资料来源，先在作品主页关联。"));
  });
});
