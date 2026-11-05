import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { unzipSync } from "fflate";
import type { BrowserWindow } from "electron";
import { DrizzleStore } from "@manga/storage-drizzle";
import { MangaProductApp, TestVault } from "@manga/app-core";
import { testHooks } from "../test-hooks.ts";
import { DRAWN, clickTestId, closeTabs, pressChord, railTo, setField, sleep, waitFrames, waitUntil } from "./driver.ts";
import { capturePage, caller, ensureDock, js, toRail } from "./common.ts";
import { waitRun } from "./loop-media.ts";

/**
 * Window observations for Agent pending proposals, per-task opt-in capabilities, and schema v14 migration (计划第 7 节, AT-151—AT-156):
 * - `proposal-delete-rename`: delete a referenced whiteboard + rename a mindmap via proposal cards, light/dark screenshots, confirm/reject, next-turn result summary;
 * - `proposal-stale-once`: edit a draft after a delete proposal -> stale on confirm; simultaneous confirm from dock + conversation tab executes once;
 * - `proposal-roughcut`: 5-step roughcut edit proposal + undo (`Agent：...`) + roughcut lossless export proposal;
 * - `proposal-export-project`: export project package proposal (confirm with directory picker -> matches owner export; cancel picker -> stays pending);
 * - `proposal-restart`: pending + applying proposals across restart recovery;
 * - `agent-opt-in`: per-task `webpage.fetch` and `semantic.search` opt-in in `+` menu, cleared after send, `webpage.fetch` absent in "最近";
 * - `migrate-v14`: v13 profile backup and migration to v14, second start no-op, newer schema version refused.
 */

type Call = ReturnType<typeof caller>;
type Seen = { url: string; body: Record<string, unknown> };

const DOCK = `document.querySelector('[data-testid="shell-dock"]')`;
const HOST = `document.querySelector('[data-testid="context-host"][data-active="true"]')`;

const ok = async <T>(call: Call, commandId: string, input: Record<string, unknown>): Promise<T> => {
  const result = await call(commandId, input);
  if (result.status !== "ok") throw new Error(`${commandId}: ${JSON.stringify(result.error ?? null).slice(0, 300)}`);
  return result.value as T;
};

function sampleDir(root: string | undefined, id: string): string | null {
  if (!root) return null;
  const manifestFile = path.join(root, "manifest.json");
  if (!fs.existsSync(manifestFile)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { samples: Array<{ id: string; path: string; status: string }> };
  const entry = manifest.samples.find((item) => item.id === id && item.status === "generated");
  return entry ? path.join(root, entry.path) : null;
}

function embedVector(text: string): number[] {
  const dim = 768;
  const vec = new Array<number>(dim).fill(0);
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 1) {
    const code = chars[i]!.codePointAt(0) ?? 0;
    vec[(code * 31) % dim]! += 0.5;
    if (i + 1 < chars.length) vec[(code * 131 + (chars[i + 1]!.codePointAt(0) ?? 0) * 17) % dim]! += 1;
  }
  return vec;
}

async function startLoopbackServices(handlers: {
  onChatRequest: (seen: Seen) => { toolCall?: { id: string; name: string; arguments: string }; text: string };
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      if (req.url === "/article") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><html><head><title>回环测试文章</title></head><body><article><h1>回环测试文章</h1><p>这是一篇用于检验按任务开启网页抓取的合成文章，讲的是琥珀色的钥匙藏在旧钟楼里。</p></article></body></html>");
        return;
      }
      if (req.url?.endsWith("/embeddings")) {
        const parsed = JSON.parse(body || "{}") as { input?: string | string[] };
        const inputs = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input ?? "")];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          data: inputs.map((text, index) => ({ index, embedding: embedVector(String(text)) })),
          usage: { prompt_tokens: 8, total_tokens: 8 },
        }));
        return;
      }
      if (req.url?.endsWith("/chat/completions")) {
        const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        const reply = handlers.onChatRequest({ url: req.url, body: parsed });
        if (!parsed.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            choices: [{ message: { role: "assistant", content: reply.text } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (reply.toolCall) {
          const tc = reply.toolCall;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 6 } })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply.text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function runProposalObservations(input: {
  appService: MangaProductApp;
  call: Call;
  view: BrowserWindow;
  evidenceDir: string | undefined;
  logsDir: string;
  samples: string | undefined;
  observe: (name: string, ok: boolean, detail: unknown) => boolean;
}): Promise<void> {
  const { appService, call, view, evidenceDir, logsDir, observe } = input;
  const videoSampleDir = sampleDir(input.samples, "video-roughcut");
  if (!videoSampleDir) {
    for (const name of ["proposal-delete-rename", "proposal-stale-once", "proposal-roughcut", "proposal-export-project", "proposal-restart", "agent-opt-in", "migrate-v14"]) {
      observe(name, false, { problems: ["the synthetic video-roughcut sample is missing"] });
    }
    return;
  }

  const tempRoot = path.join(logsDir || appService.layout.partitions.logs, "walk-proposals");
  fs.mkdirSync(tempRoot, { recursive: true });
  const seen: Seen[] = [];
  let nextToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let nextReplyText = "已整理为待确认提议。";

  const loopback = await startLoopbackServices({
    onChatRequest: (request) => {
      seen.push(request);
      if (JSON.stringify(request.body).includes("Reply with one word")) {
        return { text: "ok" };
      }
      const toolCall = nextToolCalls.shift();
      return { toolCall, text: nextReplyText };
    },
  });

  try {
    // Configure mock text model connection.
    for (const row of await ok<Array<{ id: string }>>(call, "connections.list", {})) {
      await ok(call, "connections.delete", { connectionId: row.id });
    }
    const conn = await ok<{ id: string }>(call, "connections.upsert", {
      label: "提议走查模型",
      protocol: "openai-chat-completions",
      baseUrl: `${loopback.url}/v1`,
      modelId: "mock-proposals",
      purpose: "text",
      credentialHandle: appService.stashSecret("smoke-proposals-key"),
    });
    await call("connections.test", { connectionId: conn.id, capability: "text" });
    await ok(call, "settings.setRuntime", { runtime: "native" });

    // Seed synthetic project with 3 whiteboards (1 referenced by a note and a mindmap), 2 mindmaps, 2 drafts, and a 12-clip roughcut.
    const videoFolder = path.join(tempRoot, "videos");
    fs.mkdirSync(videoFolder, { recursive: true });
    const videoFiles = ["a.mp4", "b.mp4"].map((name) => {
      const target = path.join(videoFolder, name);
      fs.copyFileSync(path.join(videoSampleDir, name), target);
      return target;
    });
    await ok(call, "library.paths.add", { pathHandle: appService.registerPath("directory", videoFolder), mediaKind: "video", autoScan: false });
    const videos: Array<{ resourceId: string; workId: string }> = [];
    for (const file of videoFiles) {
      const imported = await ok<{ resourceId: string; workId: string }>(call, "library.importDocument", {
        title: path.parse(file).name,
        kind: "video",
        pathHandle: appService.registerPath("file", file),
      });
      videos.push(imported);
    }
    const book = await ok<{ resourceId: string; workId: string }>(call, "library.importText", {
      title: "钟楼研究手记",
      bytes: [...new TextEncoder().encode(`${"旧城区的钟楼在雨夜里亮着灯。".repeat(12)}琥珀色的钥匙藏在旧钟楼第三层的暗格里。${"守夜人记下了这段话。".repeat(12)}`)],
    });

    const projectId = (await ok<{ id: string }>(call, "project.create", { name: "提议走查项目" })).id;
    for (const workId of new Set([...videos.map((v) => v.workId), book.workId])) {
      await ok(call, "project.addMaterial", { projectId, kind: "work", targetId: workId });
    }
    const board1 = (await ok<{ board: { id: string } }>(call, "whiteboard.create", { projectId, title: "白板甲" })).board.id;
    const board2 = (await ok<{ board: { id: string } }>(call, "whiteboard.create", { projectId, title: "白板乙" })).board.id;
    const board3 = (await ok<{ board: { id: string } }>(call, "whiteboard.create", { projectId, title: "白板丙" })).board.id;
    const map1 = (await ok<{ map: { id: string } }>(call, "mindmap.create", { projectId, title: "导图甲", rootText: "导图甲" })).map;
    const map2 = (await ok<{ map: { id: string } }>(call, "mindmap.create", { projectId, title: "导图乙", rootText: "导图乙" })).map.id;
    const map1Doc = await ok<{ nodes: Array<{ id: string; parentId: string | null }> }>(call, "mindmap.get", { mapId: map1.id });
    const map1RootId = map1Doc.nodes.find((n) => n.parentId === null)!.id;
    // Reference board1 from map1 and from a project note.
    await ok(call, "mindmap.edit", {
      mapId: map1.id,
      actions: [
        { type: "addChild", parentId: map1RootId, id: "node_ref_board1", text: "参见白板甲" },
        { type: "addRef", nodeId: "node_ref_board1", kind: "whiteboard", targetId: board1 },
      ],
    });
    const refNote = await ok<{ objectId: string }>(call, "notes.create", {
      title: "引用白板甲的笔记",
      text: "草图见白板甲。",
      resourceId: book.resourceId,
    });
    await ok(call, "embed.upsert", {
      sourceKind: "note",
      sourceId: refNote.objectId,
      slot: "s1",
      targetKind: "whiteboard",
      targetId: board1,
    });
    await ok(call, "project.addMaterial", { projectId, kind: "note", targetId: refNote.objectId });

    const draft1 = (await ok<{ draft: { id: string } }>(call, "draft.create", { projectId, title: "文稿甲", text: "文稿甲的初始正文。" })).draft.id;
    const draft2 = (await ok<{ draft: { id: string } }>(call, "draft.create", { projectId, title: "文稿乙", text: "文稿乙的初始正文。" })).draft.id;

    const cutId = (await ok<{ cut: { id: string } }>(call, "roughcut.create", { projectId, title: "粗剪甲" })).cut.id;
    await ok(call, "roughcut.edit", {
      cutId,
      actions: Array.from({ length: 12 }, (_, i) => ({
        type: "add",
        resourceId: videos[i % 2]!.resourceId,
        inMs: (i % 4) * 1000 + 1000,
        outMs: (i % 4) * 1000 + 2500,
      })),
    });

    // Switch window to the project context and ensure dock is visible.
    await view.webContents.reload();
    await toRail(view);
    await railTo(view, "home");
    await clickTestId(view, `context-open-${projectId}`, 6000);
    await waitUntil(view, `${HOST}?.getAttribute("data-context") === ${JSON.stringify(projectId)}`, 6000);
    await ensureDock(view);
    await clickTestId(view, "chat-mode-ask", 3000);

    const projectSession = await ok<{ id: string }>(call, "session.open", { kind: "project", targetId: projectId, contextId: projectId });
    const sessionId = projectSession.id;

    const scrollDockBottom = async () => {
      await js(view, `(() => {
        const s = ${DOCK}?.querySelector('[data-testid="chat-log"]')?.firstElementChild;
        if (s) s.scrollTop = s.scrollHeight;
        return true;
      })()`);
      await waitFrames(view, 2);
    };

    const sendFromDock = async (text: string): Promise<boolean> => {
      await ensureDock(view);
      const beforeRuns = (appService.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?").get(sessionId) as { n: number }).n;
      const clicked = await waitUntil(view, `(() => {
        const dock = ${DOCK};
        if (!dock) return false;
        const ask = dock.querySelector('[data-testid="chat-mode-ask"]');
        if (ask && ask.getAttribute("aria-pressed") !== "true") { ask.click(); return false; }
        const area = dock.querySelector('[data-testid="agent-composer"]');
        if (!area) return false;
        const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (!set) return false;
        if (area.value !== ${JSON.stringify(text)}) {
          set.call(area, ${JSON.stringify(text)});
          area.dispatchEvent(new Event("input", { bubbles: true }));
          return false;
        }
        const btn = dock.querySelector('[data-testid="agent-send"]');
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()`, 8000);
      if (!clicked) return false;
      for (let i = 0; i < 150; i += 1) {
        const afterRuns = (appService.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?").get(sessionId) as { n: number }).n;
        if (afterRuns > beforeRuns) {
          const latest = appService.store.sqlite.prepare("SELECT id FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(sessionId) as { id: string };
          await waitRun(call, latest.id);
          break;
        }
        await sleep(50); // real time: poll agent_runs until the UI send creates the run
      }
      appService.notify("proposal.changed", { sessionId });
      await waitFrames(view, 4);
      return true;
    };

    const sendCommandRun = async (text: string): Promise<{ runId: string }> => {
      const run = await ok<{ runId: string }>(call, "agent.send", { sessionId, text });
      await waitRun(call, run.runId);
      const info = await ok<{ status: string; error?: unknown; tools?: Array<{ commandId: string; status: string; result?: unknown }> }>(call, "agent.getRun", { runId: run.runId });
      appService.notify("proposal.changed", { sessionId });
      await waitFrames(view, 3);
      if (info.status !== "succeeded") {
        throw new Error(`agent.send("${text}") ended as ${info.status}: ${JSON.stringify(info.error ?? info.tools ?? null).slice(0, 400)}`);
      }
      const failedTool = (info.tools ?? []).find((t) => t.status !== "executed");
      if (failedTool) {
        throw new Error(`tool ${failedTool.commandId} in "${text}" failed: ${JSON.stringify(failedTool.result ?? null).slice(0, 400)}`);
      }
      return run;
    };

    // =========================================================================
    // 1. proposal-delete-rename
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        nextToolCalls = [
          { id: "call_del_wb", name: "proposal.delete", arguments: JSON.stringify({ kind: "whiteboard", targetId: board1, reason: "旧草图已合并" }) },
          { id: "call_ren_mm", name: "proposal.rename", arguments: JSON.stringify({ kind: "mindmap", targetId: map1.id, title: "改名后的导图甲", reason: "统一章节标题" }) },
        ];
        nextReplyText = "已为你生成删除白板甲与重命名导图甲的两条待确认提议。";

        const sent = await sendFromDock("请删除白板甲，并把导图甲重命名为改名后的导图甲");
        if (!sent) problems.push("could not click agent-send");
        const listed = await ok<{ proposals: Array<{ id: string; kind: string; status: string }> }>(call, "proposal.list", { sessionId });
        const delProp = listed.proposals.find((p) => p.kind === "delete" && p.status === "pending");
        const renProp = listed.proposals.find((p) => p.kind === "rename" && p.status === "pending");
        if (!delProp || !renProp) problems.push(`expected pending delete & rename proposals, got ${JSON.stringify(listed.proposals)}`);

        if (delProp && renProp) {
          await scrollDockBottom();
          const cardsDrawn = await waitUntil(
            view,
            `${DRAWN}(${DOCK}?.querySelector('[data-testid="proposal-card-${delProp.id}"]')) && ${DRAWN}(${DOCK}?.querySelector('[data-testid="proposal-card-${renProp.id}"]'))`,
            8000,
          );
          if (!cardsDrawn) problems.push("the delete and rename proposal cards were not drawn in the dock");

          const delText = await js<string>(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${delProp.id}"]')?.textContent ?? ""`);
          const renText = await js<string>(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${renProp.id}"]')?.textContent ?? ""`);
          const boardsBefore = (await ok<{ boards: Array<{ id: string }> }>(call, "whiteboard.list", { projectId })).boards;
          const mapBefore = (await ok<{ map: { title: string } }>(call, "mindmap.get", { mapId: map1.id })).map;
          const sidebarTextBefore = await js<string>(view, `document.querySelector('[data-testid="shell-sidebar"]')?.textContent ?? ""`);

          detail.before = {
            cardsDrawn,
            hasIrreversible: delText.includes("不能撤销"),
            hasNoteRef: delText.includes("引用白板甲的笔记"),
            hasMapRef: delText.includes("导图甲"),
            hasNewTitle: renText.includes("改名后的导图甲"),
            boardsCount: boardsBefore.length,
            mapTitle: mapBefore.title,
            sidebarHasBoard1: sidebarTextBefore.includes("白板甲"),
          };
          if (!delText.includes("不能撤销")) problems.push("delete card does not show '不能撤销'");
          if (!delText.includes("引用白板甲的笔记") || !delText.includes("导图甲")) problems.push(`delete card did not list both backlinks: ${delText}`);
          if (boardsBefore.length !== 3) problems.push(`expected 3 whiteboards before confirm, got ${boardsBefore.length}`);
          if (mapBefore.title !== "导图甲") problems.push(`mindmap title changed before confirm: ${mapBefore.title}`);

          // Capture pending delete proposal card in light and dark mode.
          await js(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${delProp.id}"]')?.scrollIntoView({ block: "center" }); true`);
          await waitFrames(view, 2);
          await capturePage(view, evidenceDir, "ui-proposal-delete-light.png", `proposal-card-${delProp.id}`);
          await js(view, `document.documentElement.setAttribute("data-theme", "dark"); true`);
          await waitFrames(view, 2);
          await capturePage(view, evidenceDir, "ui-proposal-delete-dark.png", `proposal-card-${delProp.id}`);
          await js(view, `document.documentElement.removeAttribute("data-theme"); true`);
          await waitFrames(view, 2);

          // Confirm delete, reject rename.
          await clickTestId(view, `proposal-apply-${delProp.id}`, 4000);
          const delApplied = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${delProp.id}"]')?.getAttribute("data-status") === "applied"`, 8000);
          await clickTestId(view, `proposal-reject-${renProp.id}`, 4000);
          const renRejected = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${renProp.id}"]')?.getAttribute("data-status") === "rejected"`, 8000);
          await waitFrames(view, 2);
          await capturePage(view, evidenceDir, "ui-proposal-decided.png", `proposal-card-${delProp.id}`);

          const boardsAfter = (await ok<{ boards: Array<{ id: string }> }>(call, "whiteboard.list", { projectId })).boards;
          const mapAfter = await ok<{ map: { title: string }; nodes: Array<{ id: string; refs: Array<{ targetId: string; state?: string }> }> }>(call, "mindmap.get", { mapId: map1.id });
          const checkLinks = await ok<{ backlinks: Array<{ state: string }> }>(call, "embed.backlinks", { targetKind: "whiteboard", targetId: board1 });
          const noteBacklinkDeleted = checkLinks.backlinks.some((b) => b.state === "deleted");
          const mapRefNode = mapAfter.nodes.find((n) => n.id === "node_ref_board1");

          detail.after = {
            delApplied,
            renRejected,
            boardsCount: boardsAfter.length,
            noteBacklinkDeleted,
            mapRefState: mapRefNode?.refs[0]?.state ?? "missing",
            mapTitle: mapAfter.map.title,
          };
          if (!delApplied || !renRejected) problems.push("confirm or reject did not update card status");
          if (boardsAfter.length !== 2 || boardsAfter.some((b) => b.id === board1)) problems.push("白板甲 was not deleted after confirm");
          if (!noteBacklinkDeleted) problems.push(`embed.backlinks did not mark deleted whiteboard reference as deleted: ${JSON.stringify(checkLinks.backlinks)}`);
          if (mapAfter.map.title !== "导图甲") problems.push(`rejected rename still changed mindmap title to ${mapAfter.map.title}`);

          // Next turn request carries both results once.
          const beforeTurn = seen.length;
          nextReplyText = "收到，删除已执行，重命名已取消。";
          await sendCommandRun("刚才的两条提议结果如何？");
          const turnBodies = seen.slice(beforeTurn).map((r) => JSON.stringify(r.body)).join("\n");
          const carriedBoth = turnBodies.includes("上次以来待审提议的结果") && turnBodies.includes("删除白板《白板甲》") && turnBodies.includes("重命名导图：《导图甲》");
          detail.nextTurnCarriedBoth = carriedBoth;
          if (!carriedBoth) problems.push("next turn request did not carry both proposal decision results");
        }
      } catch (error) {
        problems.push(`walk stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("proposal-delete-rename", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 2. proposal-stale-once
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        nextToolCalls = [
          { id: "call_stale_draft", name: "proposal.delete", arguments: JSON.stringify({ kind: "draft", targetId: draft1, reason: "测试失效" }) },
          { id: "call_once_draft", name: "proposal.rename", arguments: JSON.stringify({ kind: "draft", targetId: draft2, title: "同时确认的文稿乙", reason: "测试只执行一次" }) },
        ];
        nextReplyText = "已提出两条文稿提议。";
        await sendCommandRun("请处理这两篇文稿");

        const listed = await ok<{ proposals: Array<{ id: string; kind: string; status: string }> }>(call, "proposal.list", { sessionId });
        const pStale = listed.proposals.find((p) => p.kind === "delete" && p.status === "pending");
        const pOnce = listed.proposals.find((p) => p.kind === "rename" && p.status === "pending");
        if (!pStale || !pOnce) problems.push("stale/once proposals were not created");

        if (pStale && pOnce) {
          await scrollDockBottom();
          await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${pStale.id}"]') && ${DOCK}?.querySelector('[data-testid="proposal-card-${pOnce.id}"]')`, 8000);

          // Edit draft1 by one character before confirming pStale.
          const currentDraft1 = (await ok<{ draft: { version: number } }>(call, "draft.get", { draftId: draft1 })).draft;
          await ok(call, "draft.save", { draftId: draft1, expectedVersion: currentDraft1.version, text: "文稿甲的初始正文加一字。" });
          await clickTestId(view, `proposal-apply-${pStale.id}`, 4000);
          const staleShown = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${pStale.id}"]')?.getAttribute("data-status") === "stale"`, 8000);
          const draftStillThere = await ok<{ draft: { id: string; text: string } }>(call, "draft.get", { draftId: draft1 });
          detail.stale = { staleShown, draftExists: Boolean(draftStillThere.draft.id) };
          if (!staleShown) problems.push("card did not transition to stale after target draft was edited");
          if (!draftStillThere.draft.text.includes("加一字")) problems.push("edited draft was lost");

          // Open the project conversation in a main-area tab in a 2-column split so both the conversation tab and the dock show the same proposal card.
          await clickTestId(view, "layout-menu", 3000);
          await waitUntil(view, `document.querySelector('[data-testid="layout-two"]')`, 2500);
          await clickTestId(view, "layout-two", 2000);
          await waitUntil(view, `${HOST}?.getAttribute("data-columns") === "2"`, 4000);
          await clickTestId(view, "column-switch-1", 3000);
          await railTo(view, "conversation");
          await clickTestId(view, `session-open-${sessionId}`, 6000);
          await waitUntil(view, `${HOST}?.querySelector('[data-testid="chat-page-pane"]')`, 6000);
          await clickTestId(view, "column-switch-2", 3000);
          await railTo(view, "home");
          await ensureDock(view);
          await js(view, `(() => {
            for (const s of document.querySelectorAll('[data-testid="chat-log"]')) {
              if (s.firstElementChild) s.firstElementChild.scrollTop = s.firstElementChild.scrollHeight;
            }
            return true;
          })()`);
          const twoButtons = await waitUntil(view, `document.querySelectorAll('[data-testid="proposal-apply-${pOnce.id}"]').length >= 2`, 8000);
          const clickedCount = await js<number>(view, `(() => {
            const btns = [...document.querySelectorAll('[data-testid="proposal-apply-${pOnce.id}"]')];
            for (const b of btns) b.click();
            return btns.length;
          })()`);
          const bothApplied = await waitUntil(
            view,
            `[...document.querySelectorAll('[data-testid="proposal-card-${pOnce.id}"]')].every((el) => el.getAttribute("data-status") === "applied")`,
            8000,
          );
          const draft2After = await ok<{ draft: { title: string; version: number } }>(call, "draft.get", { draftId: draft2 });
          detail.once = { twoButtons, clickedCount, bothApplied, title: draft2After.draft.title, version: draft2After.draft.version };
          if (!twoButtons || clickedCount < 2) problems.push(`expected 2 confirm buttons (dock + conversation tab), found ${clickedCount}`);
          if (!bothApplied) problems.push("both cards did not settle to applied");
          if (draft2After.draft.title !== "同时确认的文稿乙") {
            problems.push(`expected draft2 new title, got title=${draft2After.draft.title}`);
          }

          // Restore single column layout and close only the conversation tab so the project tab stays focused.
          await clickTestId(view, "layout-menu", 3000);
          await waitUntil(view, `document.querySelector('[data-testid="layout-single"]')`, 2500);
          await clickTestId(view, "layout-single", 2000);
          await closeTabs(view, ["conversation"]);
          await ensureDock(view);
        }
      } catch (error) {
        problems.push(`walk stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("proposal-stale-once", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 3. proposal-roughcut
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        const beforeCut = await ok<{ clips: Array<{ id: string }>; totalMs: number }>(call, "roughcut.get", { cutId });
        const cIds = beforeCut.clips.map((c) => c.id);
        nextToolCalls = [
          {
            id: "call_rc_edit",
            name: "proposal.editRoughcut",
            arguments: JSON.stringify({
              cutId,
              label: "精简结尾并调整开场",
              reason: "精简结尾并调整开场",
              actions: [
                { type: "remove", clipId: cIds[11] },
                { type: "remove", clipId: cIds[10] },
                { type: "move", clipId: cIds[0], index: 2 },
                { type: "update", clipId: cIds[1], inMs: 1200, outMs: 1800, label: "精简镜头" },
                { type: "update", clipId: cIds[2], label: "Agent 重点镜头" },
              ],
            }),
          },
        ];
        nextReplyText = "已生成 5 步粗剪调整提议。";
        await sendCommandRun("帮我调整粗剪甲");

        const listed1 = await ok<{ proposals: Array<{ id: string; kind: string; status: string }> }>(call, "proposal.list", { sessionId });
        const pEdit = listed1.proposals.find((p) => p.kind === "editRoughcut" && p.status === "pending");
        if (!pEdit) problems.push("editRoughcut proposal was not created");
        if (pEdit) {
          await ensureDock(view);
          await scrollDockBottom();
          await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${pEdit.id}"]')`, 8000);
          const lineCount = await js<number>(view, `${DOCK}?.querySelectorAll('[data-testid="proposal-lines-${pEdit.id}"] > li').length ?? 0`);
          const summary = await js<string>(view, `${DOCK}?.querySelector('[data-testid="proposal-summary-${pEdit.id}"]')?.textContent ?? ""`);
          if (lineCount < 5) problems.push(`expected >= 5 preview lines on editRoughcut card, got ${lineCount}`);

          await clickTestId(view, `proposal-apply-${pEdit.id}`, 4000);
          const editApplied = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${pEdit.id}"]')?.getAttribute("data-status") === "applied"`, 8000);
          const afterEdit = await ok<{ clips: unknown[]; totalMs: number; ops: { undoLabel: string | null } }>(call, "roughcut.get", { cutId });
          const undoRestored = await ok<{ doc: { clips: unknown[]; totalMs: number } }>(call, "roughcut.undo", { cutId });

          detail.edit = {
            lineCount,
            summary,
            editApplied,
            clipsAfterEdit: afterEdit.clips.length,
            undoLabel: afterEdit.ops.undoLabel,
            clipsAfterUndo: undoRestored.doc.clips.length,
          };
          if (!editApplied || afterEdit.clips.length !== 10) problems.push("editRoughcut did not apply 5 steps");
          if (!String(afterEdit.ops.undoLabel ?? "").startsWith("Agent：")) problems.push(`undo label did not start with Agent： (${afterEdit.ops.undoLabel})`);
          if (undoRestored.doc.clips.length !== 12) problems.push(`undo did not restore 12 clips (got ${undoRestored.doc.clips.length})`);
        }

        // Propose roughcut export.
        nextToolCalls = [
          { id: "call_rc_export", name: "proposal.exportRoughcut", arguments: JSON.stringify({ cutId, fileName: "agent-roughcut.mp4", reason: "导出成片供审阅" }) },
        ];
        nextReplyText = "已生成粗剪导出提议。";
        await sendCommandRun("把粗剪甲导出为视频");
        const listed2 = await ok<{ proposals: Array<{ id: string; kind: string; status: string }> }>(call, "proposal.list", { sessionId });
        const pExp = listed2.proposals.find((p) => p.kind === "exportRoughcut" && p.status === "pending");
        if (!pExp) problems.push("exportRoughcut proposal was not created");
        if (pExp) {
          await scrollDockBottom();
          await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${pExp.id}"]')`, 8000);
          await clickTestId(view, `proposal-apply-${pExp.id}`, 4000);
          const expApplied = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${pExp.id}"]')?.getAttribute("data-status") === "applied"`, 8000);
          let expJob: { state: string; check: { ok: boolean } | null; fileName: string | null } | undefined;
          for (let i = 0; i < 120; i += 1) {
            const exports = (await ok<{ exports: Array<{ state: string; check: { ok: boolean } | null; fileName: string | null }> }>(call, "roughcut.exports", { cutId })).exports;
            expJob = exports[0];
            if (expJob && (expJob.state === "done" || expJob.state === "failed" || expJob.state === "cancelled")) break;
            await sleep(100); // real time: poll ffmpeg roughcut export completion
          }
          detail.export = { expApplied, state: expJob?.state, checkOk: expJob?.check?.ok, fileName: expJob?.fileName };
          if (!expApplied || expJob?.state !== "done" || expJob?.check?.ok !== true) {
            problems.push(`roughcut export proposal did not produce a verified video file: ${JSON.stringify(detail.export)}`);
          }
        }
      } catch (error) {
        problems.push(`walk stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("proposal-roughcut", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 4. proposal-export-project
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        nextToolCalls = [
          { id: "call_pkg_1", name: "proposal.exportProject", arguments: JSON.stringify({ reason: "备份当前项目" }) },
          { id: "call_pkg_2", name: "proposal.exportProject", arguments: JSON.stringify({ reason: "第二次备份（将取消）" }) },
        ];
        nextReplyText = "已生成两条项目包导出提议。";
        await sendCommandRun("导出项目包");
        const listed = await ok<{ proposals: Array<{ id: string; kind: string; status: string }> }>(call, "proposal.list", { sessionId });
        const pendingPkg = listed.proposals.filter((p) => p.kind === "exportProject" && p.status === "pending");
        if (pendingPkg.length < 2) problems.push(`expected 2 pending exportProject proposals, got ${pendingPkg.length}`);
        if (pendingPkg.length >= 2) {
          const [p1, p2] = [pendingPkg[0]!, pendingPkg[1]!];
          await scrollDockBottom();
          await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${p1.id}"]') && ${DOCK}?.querySelector('[data-testid="proposal-card-${p2.id}"]')`, 8000);

          const out1 = path.join(tempRoot, "pkg-proposal");
          const outOwner = path.join(tempRoot, "pkg-owner");
          fs.mkdirSync(out1, { recursive: true });
          fs.mkdirSync(outOwner, { recursive: true });

          // Confirm p1 with a chosen directory.
          testHooks.pick = () => out1;
          await clickTestId(view, `proposal-apply-${p1.id}`, 4000);
          const p1Applied = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${p1.id}"]')?.getAttribute("data-status") === "applied"`, 8000);
          const propOutput = (appService.proposals.getCard(p1.id).result as { output?: { fileName?: string; bytes?: number } } | null)?.output;
          const propFile = propOutput?.fileName ? path.join(out1, propOutput.fileName) : "";
          const ownerExp = await ok<{ fileName: string; bytes: number }>(call, "project.exportPackage", {
            projectId,
            pathHandle: appService.registerPath("directory", outOwner),
          });
          const ownerFile = path.join(outOwner, ownerExp.fileName);
          const propZip = propFile && fs.existsSync(propFile) ? Object.keys(unzipSync(fs.readFileSync(propFile))).sort() : [];
          const ownerZip = fs.existsSync(ownerFile) ? Object.keys(unzipSync(fs.readFileSync(ownerFile))).sort() : [];
          const filesMatch = propZip.length > 0 && JSON.stringify(propZip) === JSON.stringify(ownerZip);

          // Confirm p2 with cancelled directory picker -> stays pending.
          testHooks.pick = () => null;
          await clickTestId(view, `proposal-apply-${p2.id}`, 4000);
          await waitFrames(view, 4);
          const p2Status = await js<string | null>(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${p2.id}"]')?.getAttribute("data-status") ?? null`);
          testHooks.pick = undefined;

          detail.pkg = { p1Applied, filesMatch, zipEntries: propZip.length, p2StatusAfterCancel: p2Status };
          if (!p1Applied || !filesMatch) problems.push("exported project package did not match owner export entries");
          if (p2Status !== "pending") problems.push(`cancelling save dialog changed status to ${p2Status}`);
        }
      } catch (error) {
        testHooks.pick = undefined;
        problems.push(`walk stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("proposal-export-project", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 5. proposal-restart
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        nextToolCalls = [
          { id: "call_res_1", name: "proposal.rename", arguments: JSON.stringify({ kind: "whiteboard", targetId: board2, title: "重启后确认的白板乙", reason: "待确认项" }) },
          { id: "call_res_2", name: "proposal.rename", arguments: JSON.stringify({ kind: "whiteboard", targetId: board3, title: "重启前已落库的白板丙", reason: "模拟已提交回执" }) },
          { id: "call_res_3", name: "proposal.rename", arguments: JSON.stringify({ kind: "mindmap", targetId: map2, title: "重启前未落库的导图乙", reason: "模拟未提交回执" }) },
        ];
        nextReplyText = "已生成三条用于重启恢复核对的提议。";
        await sendCommandRun("生成三条提议测试重启恢复");
        const listed = await ok<{ proposals: Array<{ id: string; kind: string; status: string; preview: { title: string } }> }>(call, "proposal.list", { sessionId });
        const pPending = listed.proposals.find((p) => p.status === "pending" && p.preview.title.includes("白板乙"));
        const pCommitted = listed.proposals.find((p) => p.status === "pending" && p.preview.title.includes("白板丙"));
        const pUncommitted = listed.proposals.find((p) => p.status === "pending" && p.preview.title.includes("导图乙"));
        if (!pPending || !pCommitted || !pUncommitted) problems.push("restart test proposals were not created");

        if (pPending && pCommitted && pUncommitted) {
          // Simulate process termination while pCommitted and pUncommitted are in 'applying':
          // pCommitted has its idempotent receipt in storage; pUncommitted does not.
          await ok(call, "whiteboard.rename", { boardId: board3, title: "重启前已落库的白板丙" });
          appService.store.sqlite.prepare("INSERT OR IGNORE INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?, 'whiteboard.rename', ?, ?)")
            .run(pCommitted.id, JSON.stringify({ status: "ok", value: { board: { id: board3, title: "重启前已落库的白板丙" } } }), new Date().toISOString());
          appService.store.sqlite.prepare("UPDATE agent_proposals SET status = 'applying' WHERE id IN (?, ?)").run(pCommitted.id, pUncommitted.id);

          // Run startup recovery and reload the window as after a restart.
          const recovery = appService.proposals.recover();
          await view.webContents.reload();
          await toRail(view);
          await railTo(view, "home");
          await clickTestId(view, `context-open-${projectId}`, 6000);
          await ensureDock(view);
          await scrollDockBottom();

          const committedStatus = appService.proposals.getCard(pCommitted.id).status;
          const uncommittedStatus = appService.proposals.getCard(pUncommitted.id).status;
          const pendingStatus = appService.proposals.getCard(pPending.id).status;

          // Confirm pPending in the window after restart.
          await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-apply-${pPending.id}"]')`, 8000);
          await clickTestId(view, `proposal-apply-${pPending.id}`, 4000);
          const pendingApplied = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="proposal-card-${pPending.id}"]')?.getAttribute("data-status") === "applied"`, 8000);

          detail.restart = { recovery, committedStatus, uncommittedStatus, pendingStatus, pendingApplied };
          if (committedStatus !== "applied") problems.push(`applying proposal with receipt settled to ${committedStatus}, not applied`);
          if (uncommittedStatus !== "pending") problems.push(`applying proposal without receipt settled to ${uncommittedStatus}, not pending`);
          if (!pendingApplied) problems.push("pending proposal could not be confirmed after restart");
        }
      } catch (error) {
        problems.push(`walk stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("proposal-restart", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 6. agent-opt-in
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      try {
        // Add loopback embedding connection and enable semantic search.
        const embConn = await ok<{ id: string }>(call, "connections.upsert", {
          label: "回环向量服务",
          protocol: "openai-chat-completions",
          baseUrl: `${loopback.url}/v1`,
          modelId: "mock-embedding",
          purpose: "embedding",
          credentialHandle: appService.stashSecret("smoke-emb-key"),
        });
        await ok(call, "semantic.configure", { enabled: true, connectionId: embConn.id, segmentation: "paragraph-300" });
        await appService.semantic.settled();
        appService.notify("settings.changed", {});
        await waitFrames(view, 4);

        await ensureDock(view);
        await clickTestId(view, "chat-plus", 4000);
        const menuOpen = await waitUntil(
          view,
          `document.querySelector('[data-testid="chat-plus-semantic"]') && document.querySelector('[data-testid="chat-plus-webpage"]')`,
          6000,
        );
        if (!menuOpen) problems.push("chat-plus menu did not show both semantic and webpage opt-in items in project conversation");
        await waitFrames(view, 2);
        await capturePage(view, evidenceDir, "ui-chat-opt-in-menu.png", "chat-plus-webpage");

        // Tick only "抓取网页".
        await clickTestId(view, "chat-plus-webpage", 3000);
        await pressChord(view, "Escape", []);
        const webTagShown = await waitUntil(view, `${DOCK}?.querySelector('[data-testid="chat-opt-in-webpage"]')`, 4000);

        const beforeWeb = seen.length;
        nextToolCalls = [
          { id: "call_web_fetch", name: "webpage.fetch", arguments: JSON.stringify({ url: `${loopback.url}/article` }) },
        ];
        nextReplyText = "已抓取网页并存为项目的网页版本。";
        await sendFromDock(`请抓取 ${loopback.url}/article`);

        const webTools = ((seen[beforeWeb]?.body.tools as Array<{ function?: { name?: string }; name?: string }> | undefined) ?? []).map((t) => t.function?.name ?? t.name ?? "");
        const pages = (await ok<{ pages: Array<{ title: string }> }>(call, "webpage.list", {})).pages;
        const tagClearedAfterSend = !(await js<boolean>(view, `Boolean(${DOCK}?.querySelector('[data-testid="chat-opt-in-webpage"]'))`));

        // Next turn without ticking "抓取网页": tool list lacks webpage.fetch.
        const beforeNext = seen.length;
        nextReplyText = "这一轮没有勾选网页抓取。";
        await sendFromDock("现在还有网页抓取工具吗？");
        const nextTools = ((seen[beforeNext]?.body.tools as Array<{ function?: { name?: string }; name?: string }> | undefined) ?? []).map((t) => t.function?.name ?? t.name ?? "");

        // Tick "语义检索": searches fake Embedding service and succeeds.
        await clickTestId(view, "chat-plus", 4000);
        await waitUntil(view, `document.querySelector('[data-testid="chat-plus-semantic"]')`, 4000);
        await clickTestId(view, "chat-plus-semantic", 3000);
        await pressChord(view, "Escape", []);
        await waitUntil(view, `${DOCK}?.querySelector('[data-testid="chat-opt-in-semantic"]')`, 4000);

        const beforeSem = seen.length;
        nextToolCalls = [
          { id: "call_sem_search", name: "semantic.search", arguments: JSON.stringify({ text: "琥珀色的钥匙藏在哪里", limit: 3 }) },
        ];
        nextReplyText = "通过语义检索找到了旧钟楼第三层。";
        await sendFromDock("用语义检索找钥匙的位置");
        const semTools = ((seen[beforeSem]?.body.tools as Array<{ function?: { name?: string }; name?: string }> | undefined) ?? []).map((t) => t.function?.name ?? t.name ?? "");
        const semRequestBodies = seen.slice(beforeSem).map((r) => JSON.stringify(r.body)).join("\n");

        // Switch to "最近" conversation: "抓取网页" is not shown in `+` menu.
        await railTo(view, "home");
        await clickTestId(view, "context-open-recent", 6000);
        await waitUntil(view, `${HOST}?.getAttribute("data-context") === ""`, 6000);
        await ensureDock(view);
        await clickTestId(view, "chat-plus", 4000);
        await waitUntil(view, `document.querySelector('[data-testid="chat-plus-semantic"]')`, 4000);
        const webpageInRecent = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="chat-plus-webpage"]'))`);
        await pressChord(view, "Escape", []);

        detail.optIn = {
          webTagShown,
          webHasFetch: webTools.includes("webpage.fetch"),
          webHasSemantic: webTools.includes("semantic.search"),
          savedWebpages: pages.length,
          tagClearedAfterSend,
          nextHasFetch: nextTools.includes("webpage.fetch"),
          semHasSemantic: semTools.includes("semantic.search"),
          semFoundKey: semRequestBodies.includes("琥珀色的钥匙"),
          webpageInRecent,
        };
        if (!webTools.includes("webpage.fetch") || webTools.includes("semantic.search")) problems.push(`first turn tools mismatch: ${JSON.stringify(webTools)}`);
        if (pages.length === 0) problems.push("webpage.fetch did not save a webpage version in the project");
        if (!tagClearedAfterSend || nextTools.includes("webpage.fetch")) problems.push("webpage.fetch opt-in was not cleared on the next turn");
        if (!semTools.includes("semantic.search") || !semRequestBodies.includes("琥珀色的钥匙")) problems.push("semantic.search opt-in did not return results from the fake embedding service");
        if (webpageInRecent) problems.push("chat-plus-webpage was shown in '最近' conversation");
      } catch (error) {
        problems.push(`walk stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("agent-opt-in", problems.length === 0, { ...detail, problems });
    }

    // =========================================================================
    // 7. migrate-v14
    // =========================================================================
    {
      const problems: string[] = [];
      const detail: Record<string, unknown> = {};
      const v13Root = path.join(tempRoot, "v13-profile");
      try {
        fs.mkdirSync(v13Root, { recursive: true });
        const v13DataDir = path.join(v13Root, "data");
        fs.mkdirSync(v13DataDir, { recursive: true });
        // Seed a genuine v13 database with a project, a session, and a run.
        const seedStore = new DrizzleStore({ profileDir: v13DataDir, hostId: "smoke-v13-seed" });
        const now = new Date().toISOString();
        seedStore.sqlite.prepare("INSERT INTO projects(id, name, goal, status, created_at, updated_at) VALUES ('proj_v13', 'v13项目', '', 'active', ?, ?)").run(now, now);
        seedStore.sqlite.prepare("INSERT INTO agent_sessions(id, title, kind, target_id, project_id, grant_handle, created_at, updated_at) VALUES ('ses_v13', 'v13对话', 'project', 'proj_v13', 'proj_v13', 'g', ?, ?)").run(now, now);
        seedStore.sqlite.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, live_text, created_at, updated_at) VALUES ('run_v13', 'ses_v13', 'succeeded', 'g', '{}', 'v13问题', 'v13回答', ?, ?)").run(now, now);
        seedStore.sqlite.exec("DROP TABLE IF EXISTS agent_proposals");
        seedStore.sqlite.prepare("UPDATE schema_meta SET value = '13' WHERE key = 'schemaVersion'").run();
        seedStore.close();

        // First start on v13 profile -> backup + migrate to v14.
        const t0 = performance.now();
        const app1 = new MangaProductApp({
          profileRoot: v13Root,
          documentsDir: path.join(v13Root, "documents"),
          pointerPath: path.join(v13Root, "launcher", "pointer.json"),
          channel: "test",
          hostId: "smoke-v14-1",
          vault: new TestVault("smoke-v14"),
        });
        await app1.start();
        const migrateMs = Math.round((performance.now() - t0) * 100) / 100;
        const backupExists = fs.existsSync(path.join(v13DataDir, "manga.sqlite.premigrate-v13"));
        const versionAfter1 = app1.store.getMeta("schemaVersion");
        const migration1 = app1.store.migration;
        const proposalsTable = Boolean(app1.store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_proposals'").get());
        const runKept = app1.store.sqlite.prepare("SELECT input_text FROM agent_runs WHERE id = 'run_v13'").pluck().get() === "v13问题";
        app1.close();

        // Second start -> no migration.
        const app2 = new MangaProductApp({
          profileRoot: v13Root,
          documentsDir: path.join(v13Root, "documents"),
          pointerPath: path.join(v13Root, "launcher", "pointer.json"),
          channel: "test",
          hostId: "smoke-v14-2",
          vault: new TestVault("smoke-v14"),
        });
        await app2.start();
        const migration2 = app2.store.migration ?? null;
        app2.store.sqlite.prepare("UPDATE schema_meta SET value = '15' WHERE key = 'schemaVersion'").run();
        app2.close();

        // Newer version -> refused by older app.
        let newerRefused = false;
        try {
          const app3 = new MangaProductApp({
            profileRoot: v13Root,
            documentsDir: path.join(v13Root, "documents"),
            pointerPath: path.join(v13Root, "launcher", "pointer.json"),
            channel: "test",
            hostId: "smoke-v14-3",
            vault: new TestVault("smoke-v14"),
          });
          await app3.start();
          app3.close();
        } catch (err) {
          newerRefused = String(err instanceof Error ? err.message : err).includes("newer than this application");
        }

        detail.v14 = { migrateMs, backupExists, versionAfter1, migration1, proposalsTable, runKept, migration2, newerRefused };
        if (!backupExists) problems.push("manga.sqlite.premigrate-v13 backup was not created");
        if (versionAfter1 !== "14" || migration1?.from !== 13 || migration1?.to !== 14) problems.push(`unexpected first migration state: ${JSON.stringify({ versionAfter1, migration1 })}`);
        if (!proposalsTable || !runKept) problems.push("agent_proposals table missing or existing rows corrupted");
        if (migration2 !== null) problems.push("second start migrated again");
        if (!newerRefused) problems.push("newer schema version was not refused");
      } catch (error) {
        problems.push(`walk stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
      observe("migrate-v14", problems.length === 0, { ...detail, problems });
    }
  } finally {
    testHooks.pick = undefined;
    await loopback.close();
  }
}
