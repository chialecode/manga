/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { ConversationBar } from "../../apps/desktop/src/renderer/components/conversation-bar.tsx";
import { AddToProject } from "../../apps/desktop/src/renderer/components/add-to-project.tsx";
import { ProjectsPage } from "../../apps/desktop/src/renderer/pages/projects/projects-page.tsx";
import { ProjectPage, type ProjectTab } from "../../apps/desktop/src/renderer/pages/projects/project-page.tsx";

const i18n = createTranslator("zh-CN");
const t = i18n.t;

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const counts = { materials: 0, terms: 0, sessions: 0, whiteboards: 0, mindmaps: 0, drafts: 0, excerpts: 0, roughCuts: 0 };
const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, goal: "", status: "active", modelConnectionId: null, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z", counts, ...extra });

describe("the entertainment mode's conversation bar (AT-75)", () => {
  const history = [
    { sessionId: "ses_a", title: "对话 2026-10-01 10:00", excerpt: "第一段对话的第一句话", runCount: 3, updatedAt: "2026-10-01T10:00:00.000Z" },
    { sessionId: "ses_b", title: "对话 2026-09-30 09:00", excerpt: "", runCount: 0, updatedAt: "2026-09-30T09:00:00.000Z" },
  ];

  it("names the current conversation and starts a new one", async () => {
    installHost({ "conversation.history": () => ({ current: "ses_now", items: history }) });
    const onNew = vi.fn();
    render(<ConversationBar t={t} mode="enthusiast" title="对话 2026-10-02 08:00" version={0} formatDate={i18n.formatDate} onNew={onNew} onResume={() => undefined} onError={() => undefined} />);
    expect(screen.getByTestId("conversation-title").textContent).toBe("对话 2026-10-02 08:00");
    fireEvent.click(screen.getByTestId("conversation-new"));
    expect(onNew).toHaveBeenCalledTimes(1);
    // The panel is not open until the history is asked for.
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
  });

  it("lists the history with title, time and the start of what was said, continues one, and closes with Escape", async () => {
    const host = installHost({ "conversation.history": () => ({ current: "ses_now", items: history }) });
    const resume = vi.fn();
    render(<ConversationBar t={t} mode="enthusiast" title="现在" version={0} formatDate={i18n.formatDate} onNew={() => undefined} onResume={resume} onError={() => undefined} />);
    fireEvent.click(screen.getByTestId("conversation-history"));
    await waitFor(() => expect(screen.getByTestId("conversation-item-ses_a")).toBeTruthy());
    expect(host.of("conversation.history")[0]!.input).toEqual({ mode: "enthusiast", limit: 50 });
    const first = screen.getByTestId("conversation-item-ses_a");
    expect(first.textContent).toContain("对话 2026-10-01 10:00");
    expect(first.textContent).toContain("第一段对话的第一句话");
    expect(first.textContent).toContain("3 次提问");
    // A conversation with nothing said says so instead of showing an empty line.
    expect(screen.getByTestId("conversation-item-ses_b").textContent).toContain("没有消息");
    fireEvent.click(first);
    expect(resume).toHaveBeenCalledWith("ses_a");
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("conversation-history"));
    await waitFor(() => expect(screen.getByTestId("conversation-panel")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
  });

  it("says the history is empty before a second conversation exists, and reads it again when the conversations change", async () => {
    let items: typeof history = [];
    const host = installHost({ "conversation.history": () => ({ current: "ses_now", items }) });
    const view = render(<ConversationBar t={t} mode="creator" title="" version={0} formatDate={i18n.formatDate} onNew={() => undefined} onResume={() => undefined} onError={() => undefined} />);
    expect(screen.getByTestId("conversation-title").textContent).toBe("当前对话");
    fireEvent.click(screen.getByTestId("conversation-history"));
    await waitFor(() => expect(screen.getByTestId("conversation-empty")).toBeTruthy());
    expect(host.of("conversation.history")[0]!.input).toMatchObject({ mode: "creator" });
    items = history;
    view.rerender(<ConversationBar t={t} mode="creator" title="" version={1} formatDate={i18n.formatDate} onNew={() => undefined} onResume={() => undefined} onError={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("conversation-item-ses_a")).toBeTruthy());
  });
});

describe("the projects page (AT-25)", () => {
  it("creates a project and opens it, and archives and restores one", async () => {
    let projects = [project("prj_1", "合集解说", { goal: "做一期合集解说", counts: { ...counts, materials: 2, sessions: 1 } })];
    const host = installHost({
      "project.list": (input) => ({ projects: projects.filter((item) => item.status === (input.status ?? "active")) }),
      "project.create": (input) => { const created = project("prj_2", String(input.name), { goal: input.goal ?? "" }); projects = [created, ...projects]; return created; },
      "project.update": (input) => { projects = projects.map((item) => item.id === input.projectId ? { ...item, status: String(input.status) } : item); return {}; },
    });
    const opened: string[] = [];
    const notices: string[] = [];
    render(<ProjectsPage t={t} formatDate={i18n.formatDate} version={0} onOpen={(id) => opened.push(id)} onChanged={() => undefined} onError={() => undefined} onNotice={(message) => notices.push(message)} />);
    await waitFor(() => expect(screen.getByTestId("project-prj_1")).toBeTruthy());
    expect(screen.getByTestId("project-prj_1").textContent).toContain("2 个材料 · 1 个会话");
    expect(screen.getByTestId("project-prj_1").textContent).toContain("做一期合集解说");

    fireEvent.click(screen.getByTestId("projects-new"));
    expect((screen.getByTestId("project-create-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("project-name"), { target: { value: "新项目" } });
    fireEvent.change(screen.getByTestId("project-goal"), { target: { value: "目标一句话" } });
    fireEvent.click(screen.getByTestId("project-create-submit"));
    await waitFor(() => expect(opened).toEqual(["prj_2"]));
    expect(host.of("project.create")[0]!.input).toEqual({ name: "新项目", goal: "目标一句话" });
    expect(notices.at(-1)).toBe("已创建项目“新项目”");

    fireEvent.click(screen.getByTestId("project-archive-prj_1"));
    await waitFor(() => expect(screen.queryByTestId("project-prj_1")).toBeNull());
    expect(host.of("project.update")[0]!.input).toEqual({ projectId: "prj_1", status: "archived" });
    fireEvent.click(screen.getByTestId("projects-filter-archived"));
    await waitFor(() => expect(screen.getByTestId("project-prj_1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("project-archive-prj_1"));
    await waitFor(() => expect(screen.queryByTestId("project-prj_1")).toBeNull());
    expect(host.of("project.update")[1]!.input).toEqual({ projectId: "prj_1", status: "active" });
  });

  it("asks before deleting and says what goes with the project: its own objects, not the personal ones it only refers to", async () => {
    let projects = [project("prj_1", "要删的项目", { counts: { ...counts, materials: 4, whiteboards: 1, mindmaps: 2, drafts: 1, excerpts: 3, roughCuts: 1 } })];
    const host = installHost({
      "project.list": () => ({ projects }),
      "project.delete": (input) => { projects = projects.filter((item) => item.id !== input.projectId); return { removed: {} }; },
    });
    const notices: string[] = [];
    render(<ProjectsPage t={t} formatDate={i18n.formatDate} version={0} onOpen={() => undefined} onChanged={() => undefined} onError={() => undefined} onNotice={(message) => notices.push(message)} />);
    await waitFor(() => expect(screen.getByTestId("project-prj_1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("project-delete-prj_1"));
    expect(screen.getByTestId("project-delete-text").textContent).toContain("“要删的项目”");
    expect(screen.getByTestId("project-delete-text").textContent).toContain("共 8 个");
    expect(screen.getByTestId("project-delete-text").textContent).toContain("被引用的作品、资源、笔记和录音不受影响");
    // Cancelling deletes nothing.
    fireEvent.click(screen.getByTestId("project-delete-cancel"));
    expect(host.of("project.delete")).toEqual([]);
    fireEvent.click(screen.getByTestId("project-delete-prj_1"));
    fireEvent.click(screen.getByTestId("project-delete-do"));
    await waitFor(() => expect(screen.queryByTestId("project-prj_1")).toBeNull());
    expect(host.of("project.delete")[0]!.input).toEqual({ projectId: "prj_1" });
    expect(notices.at(-1)).toBe("已删除项目“要删的项目”");
    expect(screen.getByTestId("projects-empty")).toBeTruthy();
  });
});

describe("one project's page (AT-25)", () => {
  function Page(props: { tab?: ProjectTab; facets?: string[]; detail: unknown; connections?: Array<{ id: string; label: string; purpose: string; modelId?: string }>; onTab?: (tab: ProjectTab) => void; onOpenMaterial?: (material: unknown) => void; notices?: string[]; renderTab?: Parameters<typeof ProjectPage>[0]["renderTab"] }) {
    return (
      <ProjectPage
        t={t} formatDate={i18n.formatDate} projectId="prj_1" tab={props.tab ?? "materials"} facets={new Set(props.facets ?? [])} connections={props.connections ?? []}
        version={0} focus={null} onFocus={() => undefined} onTab={props.onTab ?? (() => undefined)} onBack={() => undefined} onChanged={() => undefined}
        onOpenMaterial={(props.onOpenMaterial ?? (() => undefined)) as never} onError={() => undefined} onNotice={(message) => props.notices?.push(message)} renderTab={props.renderTab}
      />
    );
  }
  const detail = (extra: Record<string, unknown> = {}) => ({ project: project("prj_1", "合集解说", { goal: "做一期合集解说" }), materials: [], terms: [], sessions: [], ...extra });

  it("shows the tabs of the modules that are on and leaves out the ones that are off", async () => {
    installHost({ "project.get": () => detail() });
    const view = render(<Page facets={[]} detail={detail()} />);
    await waitFor(() => expect(screen.getByTestId("project-title").textContent).toBe("合集解说"));
    expect([...screen.getByTestId("project-tabs").querySelectorAll("[role=tab]")].map((tab) => tab.getAttribute("data-testid"))).toEqual(["project-tab-materials", "project-tab-terms", "project-tab-settings"]);
    view.unmount();
    render(<Page facets={["whiteboard", "mindmap", "copywriting", "research", "roughcut"]} detail={detail()} />);
    await waitFor(() => expect(screen.getByTestId("project-tab-roughcut")).toBeTruthy());
    expect([...screen.getByTestId("project-tabs").querySelectorAll("[role=tab]")].map((tab) => tab.getAttribute("data-testid"))).toEqual(
      ["materials", "whiteboard", "mindmap", "draft", "excerpt", "roughcut", "terms", "settings"].map((id) => `project-tab-${id}`),
    );
  });

  it("lists materials as references, marks one whose target is gone or whose module is off, opens the rest, and removes a reference", async () => {
    let materials = [
      { id: "mat1", kind: "work", targetId: "w1", label: "合成作品", state: "ok", addedAt: "2026-10-01T00:00:00.000Z" },
      { id: "mat2", kind: "note", targetId: "n1", label: "已删除的笔记", state: "missing", addedAt: "2026-10-01T00:00:00.000Z" },
      { id: "mat3", kind: "whiteboard", targetId: "b1", label: "白板一", state: "disabled", addedAt: "2026-10-01T00:00:00.000Z" },
    ];
    const host = installHost({ "project.get": () => detail({ materials }), "project.removeMaterial": (input) => { materials = materials.filter((item) => item.id !== input.materialId); return {}; } });
    const opened: unknown[] = [];
    render(<Page detail={detail()} onOpenMaterial={(material) => opened.push(material)} />);
    await waitFor(() => expect(screen.getByTestId("material-mat1")).toBeTruthy());
    expect(screen.getByTestId("material-state-mat2").textContent).toBe("已不存在");
    expect(screen.getByTestId("material-state-mat3").textContent).toBe("对应功能已停用");
    // A reference that points at nothing keeps its name but cannot be opened; the others can.
    expect(screen.queryByTestId("material-open-mat2")).toBeNull();
    expect(screen.queryByTestId("material-open-mat3")).toBeNull();
    fireEvent.click(screen.getByTestId("material-open-mat1"));
    expect(opened).toEqual([expect.objectContaining({ kind: "work", targetId: "w1" })]);
    fireEvent.click(screen.getByTestId("material-remove-mat2"));
    await waitFor(() => expect(screen.queryByTestId("material-mat2")).toBeNull());
    expect(host.of("project.removeMaterial")[0]!.input).toEqual({ projectId: "prj_1", materialId: "mat2" });
  });

  it("adds a note as a material from the list of notes", async () => {
    let materials: unknown[] = [];
    const host = installHost({
      "project.get": () => detail({ materials }),
      "notes.list": () => [{ objectId: "n1", title: "第一条笔记", revision: 1, tags: [], preview: "", resourceId: null, anchorId: null, updatedAt: "2026-10-01T00:00:00.000Z" }],
      "project.addMaterial": (input) => { materials = [{ id: "mat1", kind: input.kind, targetId: input.targetId, label: "第一条笔记", state: "ok", addedAt: "2026-10-01T00:00:00.000Z" }]; return {}; },
    });
    const notices: string[] = [];
    render(<Page detail={detail()} notices={notices} />);
    await waitFor(() => expect(screen.getByTestId("materials-empty")).toBeTruthy());
    expect((screen.getByTestId("material-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("material-kind"), { target: { value: "note" } });
    await waitFor(() => expect(within(screen.getByTestId("material-note")).getAllByRole("option").length).toBe(2));
    fireEvent.change(screen.getByTestId("material-note"), { target: { value: "n1" } });
    fireEvent.click(screen.getByTestId("material-add"));
    await waitFor(() => expect(screen.getByTestId("material-mat1")).toBeTruthy());
    expect(host.of("project.addMaterial")[0]!.input).toEqual({ projectId: "prj_1", kind: "note", targetId: "n1" });
    expect(notices.at(-1)).toBe("已加入项目");
  });

  it("keeps the project's own glossary: add, change, delete, and fill it from a work's dictionary", async () => {
    let terms = [{ id: "t1", term: "绫波丽", heard: null, note: null }];
    const host = installHost({
      "project.get": () => detail({ terms }),
      "works.list": () => ({ items: [{ id: "w1", title: "作品甲", mediaKind: "video" }], total: 1, nextCursor: null }),
      "project.addTerm": (input) => { terms = [...terms, { id: "t2", term: String(input.term), heard: (input.heard as string) ?? null, note: (input.note as string) ?? null }]; return {}; },
      "project.updateTerm": (input) => { terms = terms.map((item) => item.id === input.termId ? { ...item, term: String(input.term), heard: input.heard as string | null, note: input.note as string | null } : item); return {}; },
      "project.removeTerm": (input) => { terms = terms.filter((item) => item.id !== input.termId); return {}; },
      "project.importTerms": () => ({ added: 3, skipped: 1 }),
    });
    const notices: string[] = [];
    render(<Page tab="terms" detail={detail()} notices={notices} />);
    await waitFor(() => expect(screen.getByTestId("pterm-t1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("pterm-term"), { target: { value: "碇真嗣" } });
    fireEvent.change(screen.getByTestId("pterm-note"), { target: { value: "主人公" } });
    fireEvent.click(screen.getByTestId("pterm-add"));
    await waitFor(() => expect(screen.getByTestId("pterm-t2")).toBeTruthy());
    expect(host.of("project.addTerm")[0]!.input).toEqual({ projectId: "prj_1", term: "碇真嗣", note: "主人公" });
    fireEvent.click(screen.getByTestId("pterm-edit-t2"));
    fireEvent.change(screen.getByTestId("pterm-edit-heard"), { target: { value: "真似" } });
    fireEvent.click(screen.getByTestId("pterm-edit-save"));
    await waitFor(() => expect(screen.getByTestId("pterm-t2").textContent).toContain("← 真似"));
    fireEvent.click(screen.getByTestId("pterm-remove-t1"));
    await waitFor(() => expect(screen.queryByTestId("pterm-t1")).toBeNull());
    await waitFor(() => expect(within(screen.getByTestId("pterm-work-select")).getAllByRole("option").length).toBe(2));
    fireEvent.change(screen.getByTestId("pterm-work-select"), { target: { value: "w1" } });
    fireEvent.click(screen.getByTestId("pterm-import"));
    await waitFor(() => expect(notices.at(-1)).toBe("导入了 3 个词条，1 个已有或放不下"));
    expect(host.of("project.importTerms")[0]!.input).toEqual({ projectId: "prj_1", workId: "w1" });
  });

  it("picks the text connection the project's conversations use and goes back to the default", async () => {
    let modelConnectionId: string | null = null;
    const host = installHost({
      "project.get": () => detail({ project: project("prj_1", "合集解说", { modelConnectionId }) }),
      "project.update": (input) => { if ("modelConnectionId" in input) modelConnectionId = input.modelConnectionId as string | null; return {}; },
    });
    const connections = [{ id: "c_text", label: "文本模型", purpose: "text", modelId: "gpt" }, { id: "c_asr", label: "转录", purpose: "transcription" }];
    render(<Page tab="settings" detail={detail()} connections={connections} />);
    await waitFor(() => expect(screen.getByTestId("psettings-model")).toBeTruthy());
    // Only text connections are offered.
    expect(within(screen.getByTestId("psettings-model")).getAllByRole("option").map((option) => option.textContent)).toEqual(["使用默认文本连接", "文本模型 · gpt"]);
    fireEvent.change(screen.getByTestId("psettings-model"), { target: { value: "c_text" } });
    await waitFor(() => expect((screen.getByTestId("psettings-model") as HTMLSelectElement).value).toBe("c_text"));
    expect(host.of("project.update")[0]!.input).toEqual({ projectId: "prj_1", modelConnectionId: "c_text" });
    fireEvent.change(screen.getByTestId("psettings-model"), { target: { value: "" } });
    await waitFor(() => expect(host.of("project.update")[1]!.input).toEqual({ projectId: "prj_1", modelConnectionId: null }));
  });

  it("says the project no longer exists when it was deleted elsewhere", async () => {
    installHost({ "project.get": () => { throw Object.assign(new Error("the project does not exist"), { code: "NOT_FOUND" }); } });
    render(<Page detail={detail()} />);
    await waitFor(() => expect(screen.getByTestId("project-missing")).toBeTruthy());
  });
});

describe("adding something to a project from another page", () => {
  it("adds the work to the chosen project, or to a new one made on the spot", async () => {
    const host = installHost({
      "project.list": () => ({ projects: [{ id: "prj_1", name: "合集解说" }] }),
      "project.create": () => ({ id: "prj_9", name: "新建" }),
    });
    const added: string[] = [];
    const notices: string[] = [];
    render(<AddToProject t={t} kind="work" targetId="w1" label="合成作品" onAdded={(id) => added.push(id)} onError={() => undefined} onNotice={(message) => notices.push(message)} />);
    fireEvent.click(screen.getByTestId("add-to-project"));
    await waitFor(() => expect(screen.getByTestId("add-to-project-prj_1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("add-to-project-prj_1"));
    await waitFor(() => expect(added).toEqual(["prj_1"]));
    expect(host.of("project.addMaterial")[0]!.input).toEqual({ projectId: "prj_1", kind: "work", targetId: "w1", label: "合成作品" });
    expect(notices.at(-1)).toBe("已加入项目");
    fireEvent.click(screen.getByTestId("add-to-project"));
    await waitFor(() => expect(screen.getByTestId("add-to-project-name")).toBeTruthy());
    fireEvent.change(screen.getByTestId("add-to-project-name"), { target: { value: "新建" } });
    fireEvent.click(screen.getByTestId("add-to-project-create"));
    await waitFor(() => expect(added).toEqual(["prj_1", "prj_9"]));
    expect(host.of("project.addMaterial")[1]!.input).toMatchObject({ projectId: "prj_9", kind: "work", targetId: "w1" });
  });
});
