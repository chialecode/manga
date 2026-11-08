/** Constants and helpers of the product application, shared by the class and its command modules. */
import path from "node:path";
import { commandInputJsonSchema, MangaError } from "@manga/contracts";
import type { ParsedAsset, ParsedDocument } from "./domain/formats.ts";
import { estimateTokens, truncateToTokens } from "./agent-context.ts";
import { publicMedia, type FrozenMedia } from "./agent-materials.ts";

/** The features every profile has had from the start, and the media ones added later; a profile saved earlier gets the later ones switched on once. */
export const BASE_FEATURES = ["library", "notes", "settings", "inventory", "agent"];
export const MEDIA_FEATURES = ["comic", "video", "metadata", "voice", "danmaku"];
/** Features added by the creative workspace; a profile saved before them gets them switched on once, the same way. */
export const CREATIVE_FEATURES = ["projects", "embeds", "whiteboard", "mindmap", "copywriting", "research", "semantic", "plugins", "acquisition", "roughcut"];
/** Without these the app cannot show its library or its settings, so they cannot be switched off. */
export const CORE_FEATURES = new Set(["library", "settings"]);
/** Partitions whose files are only located by path, so a move may leave them behind as an indexed root. `data` and `attachments` are referenced by identity and must travel. */
export const INDEXABLE_PARTITIONS = new Set<string>(["resources", "downloads", "backups", "exports", "cache"]);

export const VISION_READING_MARK = "【图像识别结果】";
// The side of the picture a probe sends. Vision models have a smallest picture they read (Qwen's take more than 28 pixels a side and refuse a smaller one as a
// bad request, which would read as "takes no pictures"), so it is well above that and still costs only a few tokens.
export const PROBE_PICTURE_SIDE = 64;

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  "library.find": "在已授权的资源中检索文本片段，返回命中的片段与资源 ID。",
  "library.list": "分页列出全库资源，可按书名搜索；返回总数与下一页游标。",
  "library.getResource": "读取一个已授权资源的最新修订正文。",
  "library.read": "按资源与修订读取指定片段的一段正文。",
  "library.contextSnapshot": "按资源修订与码点范围读取一段引用上下文。",
  "source.card": "读取一个资源的来源卡片（标题、修订、可用性与命中片段）。",
  "notes.create": "创建一条新的笔记；可关联一个已授权的资源 ID。",
  "notes.update": "按修订更新一条笔记中某个块或单块笔记的正文。",
  "notes.get": "按对象 ID 读取一条笔记的块、标签与来源。",
  "notes.list": "列出当前授权范围内的笔记摘要；可按文本、标签或资源筛选。",
  "notes.undo": "撤销本次任务创建的笔记的上一次修改。",
  "inventory.overview": "读取资源、笔记与附件的总览统计。",
  "works.list": "分页列出授权范围内的作品摘要（标题、媒介、书架状态、进度）；可按书名、媒介或状态筛选。",
  "works.get": "读取一部授权范围内作品的资料、各资源及其进度。",
  "progress.get": "读取一个资源的阅读或观看进度与已消费范围。",
  "comic.pages": "读取一部漫画的页面清单（页面 ID、序号、尺寸），不含图像。",
  "material.subtitleWindow": "读取本任务所给视频在某个位置之前的字幕文本；结果不会越过用户给定的位置或已看范围，这个限制不能放宽。",
  "metadata.search": "联网搜索外部资料源（本任务已由用户授权联网），只返回带来源的候选，不会改动资源库。",
  "semantic.search": "在本次任务可读的资料范围内做语义检索（本任务已由用户开启语义检索，会调用 Embedding 服务），返回相似度最高的片段与出处，不会越过防剧透边界。",
  "webpage.fetch": "按给定的 http/https 地址抓取一个网页并保存为本项目的网页版本（本任务已由用户授权抓取网页），只提取纯文本。",
  "library.scan.status": "读取资源库路径的扫描进度与最近几次结果（新增、变化、移动、不可用与失败的数量），不含本机路径。",
  "log.query": "按类别、结果、时间与关键字读取操作日志，了解用户、Agent 与系统做过哪些改动；日志不含正文与凭据。",
  "screenshot.list": "列出一个已授权资源的截图（时间或页、字幕文本、尺寸）；不含图像与本机路径，也不会给出用户尚未看到的时刻。",
  "screenshot.get": "读取一张截图的来源与当时的字幕文本；不含图像与本机路径，用户尚未看到的时刻读不到。",
  "danmaku.around": "读取一部视频在某个时刻附近已缓存的弹幕：条数与若干条文字（来自弹弹play开放弹幕网络）。只读本机缓存，不会联网；不会越过用户已看到的位置。",
  // The creative commands below are given only to a conversation of a project, and reach only that project (no projectId is asked for).
  "project.list": "读取本任务所属项目的名称、目标与各类对象的数量。",
  "project.get": "读取本项目的详情：目标、材料引用、术语与各类对象。",
  "project.objects": "列出本项目的对象（白板、导图、文稿、摘录、粗剪）与引用的材料，含 ID、名称与可用状态。",
  "project.terms": "读取本项目的术语表。",
  "project.addMaterial": "把一份材料的引用加入本项目：可以是你可读的资源、本任务创建的或项目已有的笔记、项目的摘录。只加引用，不复制；用户可以在项目里移除它。",
  "project.addTerm": "向本项目的术语表加一条新术语（可带听写常见误写与说明）；已有的术语不会被改动，用户可以删除这条。",
  "whiteboard.list": "列出本项目的白板。",
  "whiteboard.get": "读取本项目一块白板的卡片、连线与引用（内容过长时会截短并注明）。",
  "whiteboard.edit": "编辑本项目的一块白板：一次调用是一次修改，用户按白板的撤销就能整体撤回。可添加、移动、改写卡片，连线、分组与整理；不能删除白板。",
  "mindmap.list": "列出本项目的思维导图。",
  "mindmap.get": "读取本项目一张导图的节点（内容过长时会截短并注明）。",
  "mindmap.edit": "编辑本项目的一张导图：一次调用是一次修改，用户按导图的撤销就能整体撤回。可添加、改写、移动节点和引用；不能删除导图。",
  "draft.list": "列出本项目的文稿。",
  "draft.get": "读取本项目一篇文稿的正文、版本与建议（正文过长时会截短并注明）。",
  "draft.version": "读取本项目一篇文稿某个历史版本的正文。",
  "draft.suggest": "为本项目的一篇文稿写一条建议：由你写出建议的正文（text），种类决定它如何并入（润色或翻译替换所选范围，续写接在后面，提纲放在前面）。建议不会改动文稿，由用户查看差异后决定是否采纳。",
  "roughcut.list": "列出本项目的粗剪序列。",
  "roughcut.get": "读取本项目一个粗剪序列的片段与参数。",
  "research.search": "在本项目的材料里检索：项目引用的作品、笔记、录音与摘录，不含全库其他内容，也不含网页全文。返回带来源的片段。",
  "excerpt.list": "列出本项目的网页摘录。",
  "excerpt.get": "读取本项目一条网页摘录的原文、出处与备注。",
  "webpage.list": "列出本项目摘录过的网页（只含已保存的版本，不会联网抓取）。",
  "webpage.get": "读取本项目摘录过的一个已保存网页的正文与本项目的摘录（正文过长时会截短并注明）。",
  "proposal.delete": "提出删除本项目的一个对象（白板、思维导图、文稿或粗剪）：只写入待审提议并生成内容与引用预览，用户确认后才会删除。",
  "proposal.rename": "提出重命名本项目（或其中的白板、思维导图、文稿、粗剪）：只写入待审提议并生成预览，用户确认后才会改名。",
  "proposal.exportProject": "提出导出本项目的项目包：只写入待审提议并生成数量与大小预览，用户确认并选择文件夹后才会导出。",
  "proposal.editRoughcut": "提出调整本项目的一个粗剪序列（加入、调整、移动、删除片段或修改说明）：先在副本上验证并生成步骤与时长预览，用户确认后才会应用（可在粗剪撤销列表里撤回）。",
  "proposal.exportRoughcut": "提出导出本项目的一个粗剪序列：先生成导出计划与问题预览，用户确认后才会开始导出。",
};

/** What the receipt shows of a call's arguments; a long one ends with a hash, so two calls that start alike stay apart. */
export function toolInputSummary(args: string, inputHash: string): string {
  return args.length <= 200 ? args : `${args.slice(0, 150)}…#${inputHash.slice(0, 16)}`;
}

export function toolParameters(commandId: string): Record<string, unknown> {
  return commandInputJsonSchema(commandId) ?? { type: "object", additionalProperties: false, properties: {} };
}

/** Opaque keyset cursor over (created_at, id), so pages stay stable while the library grows. */
export function encodeResourceCursor(row: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ a: row.createdAt, i: row.id }), "utf8").toString("base64url");
}

export function decodeResourceCursor(cursor: string): { createdAt: string; id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { a?: unknown; i?: unknown };
    if (typeof parsed.a !== "string" || typeof parsed.i !== "string" || !parsed.a || !parsed.i) return undefined;
    return { createdAt: parsed.a, id: parsed.i };
  } catch {
    return undefined;
  }
}

export function codePointSafeEnd(text: string, start: number): number {
  return Math.min(start + 240, [...text].length);
}

/** What one run may use: the person's limits, and the model's window and answer from its profile when the run began (the loop reads the profile again when it runs). */
export type AgentLoopBudget = { maxSteps: number; maxDurationMs: number; contextWindow: number; contextTokens: number; maxOutputTokens: number; maxCostUsd?: number };

/**
 * How the context budget is shared when a task is sent: the earlier conversation may take up to a third, the frozen material up to two fifths, and the rest is left
 * for the question, the tool results of the task and the room the model needs. Whatever is more than fits is cut here at the source, or compressed in the loop.
 */
export function contextShares(contextTokens: number, question: string): { history: number; material: number } {
  const free = Math.max(0, contextTokens - estimateTokens(question));
  return { history: Math.floor(free / 3), material: Math.floor(contextTokens * 0.4) };
}

/** Cut by tokens keeps a character whole, and the cut says so: the model must not mistake a clipped material for a complete one. */
export function clipMaterial(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;
  const note = "\n\n（材料超出长度预算，后面的部分没有提供。）";
  return `${truncateToTokens(content, Math.max(0, maxTokens - estimateTokens(note))).text}${note}`;
}

/** The service refused the request as too long and it could not be made shorter: the window in the settings is probably larger than the model's own. */
export const refusedByService = (contextWindow: number) => new MangaError("BUDGET_EXCEEDED", `服务认为这次请求的上下文超出了模型能接受的长度，缩减后仍被拒绝。模型设置里的上下文窗口（现在是 ${contextWindow}）可能比实际的大，请改成模型真实的数值，或换一个窗口更大的模型。`, { details: { reason: "service_refused_context", contextWindow } });

/** Whether the words of an error mean the request was longer than the model takes. */
export const isContextOverflow = (error: unknown): boolean => error instanceof MangaError && (error.details as { kind?: string } | undefined)?.kind === "context";

export type ModelPurposeName = "text" | "transcription" | "embedding" | "vision";

export type ConnectionRow = {
  id: string;
  purpose: ModelPurposeName;
  verified_capabilities_json?: string;
  protocol: "openai-responses" | "openai-chat-completions";
  runtime: string | null;
  base_url: string;
  model_id: string;
  timeout_ms: number;
  credential_ref: string | null;
  profile_json?: string | null;
};

/** The receipt of a run shows what was frozen without the picture bytes; those stay in the main process. */
export function redactSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const value = snapshot as { media?: FrozenMedia };
  return value.media ? { ...value, media: publicMedia(value.media) } : value;
}

export function mimeForAudio(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".webm") return "audio/webm";
  return "application/octet-stream";
}

export function safeJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Restore base64 asset payloads that crossed the line-delimited JSON worker boundary. */
export function decodeWorkerAssets(parsed: ParsedDocument): ParsedDocument {
  if (!parsed.assets?.length) return parsed;
  return {
    ...parsed,
    assets: parsed.assets.map((asset) => {
      const encoded = asset as ParsedAsset & { bytesEncoding?: string; bytes: Uint8Array | string };
      if (encoded.bytesEncoding === "base64" && typeof encoded.bytes === "string") {
        return { ...asset, bytes: new Uint8Array(Buffer.from(encoded.bytes, "base64")) };
      }
      return asset;
    }),
  };
}
