import { z } from "zod";

/**
 * Quick tasks (A-52): named prompt templates the user keeps in settings and sends from the right pane or the chat page.
 * A template is text with a few placeholders from a fixed list. There is no template language: a placeholder is replaced by a
 * value or by nothing, and a name that is not on the list is refused when the task is saved, so a template can never look as if
 * it could run something.
 */
export const QUICK_PLACEHOLDERS = ["作品", "作者", "当前位置", "选区", "字幕窗口", "用户输入"] as const;
export type QuickPlaceholder = (typeof QUICK_PLACEHOLDERS)[number];

export const QUICK_PAGES = ["library", "work", "novel", "comic", "video", "chat"] as const;
export type QuickPage = (typeof QUICK_PAGES)[number];

export const QUICK_SEND_MODES = ["send", "fill"] as const;
export const QUICK_TEMPLATE_MAX = 2000;
export const QUICK_NAME_MAX = 40;
/** A selection longer than this is cut when it is put into a message, and the message says so. */
export const QUICK_VALUE_MAX = 2000;

export const QuickTaskDraftSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(QUICK_NAME_MAX),
  template: z.string().trim().min(1).max(QUICK_TEMPLATE_MAX),
  pages: z.array(z.enum(QUICK_PAGES)).min(1).max(QUICK_PAGES.length),
  includeFrame: z.boolean(),
  includeLibrary: z.boolean().optional(),
  sendMode: z.enum(QUICK_SEND_MODES),
  enabled: z.boolean().optional(),
}).strict();
export type QuickTaskDraft = z.infer<typeof QuickTaskDraftSchema>;

export type QuickTask = {
  id: string;
  builtinKey: string | null;
  name: string;
  template: string;
  pages: QuickPage[];
  includeFrame: boolean;
  includeLibrary: boolean;
  sendMode: "send" | "fill";
  enabled: boolean;
  builtin: boolean;
  order: number;
};

type Token = { kind: "text"; text: string } | { kind: "slot"; name: string };

/** `{名称}` is a placeholder; `{{` and `}}` are literal braces. */
function tokenize(template: string): Token[] {
  const out: Token[] = [];
  let text = "";
  for (let i = 0; i < template.length; i += 1) {
    const char = template[i]!;
    if ((char === "{" || char === "}") && template[i + 1] === char) { text += char; i += 1; continue; }
    if (char === "{") {
      const end = template.indexOf("}", i + 1);
      const inner = end < 0 ? null : template.slice(i + 1, end);
      if (inner !== null && !inner.includes("{") && !inner.includes("\n")) {
        if (text) { out.push({ kind: "text", text }); text = ""; }
        out.push({ kind: "slot", name: inner.trim() });
        i = end;
        continue;
      }
    }
    text += char;
  }
  if (text) out.push({ kind: "text", text });
  return out;
}

/** Names in the template that are not on the list; empty when the template can be saved. */
export function unknownPlaceholders(template: string): string[] {
  const unknown = new Set<string>();
  for (const token of tokenize(template)) if (token.kind === "slot" && !(QUICK_PLACEHOLDERS as readonly string[]).includes(token.name)) unknown.add(token.name || "（空）");
  return [...unknown];
}

export type RenderedTask = {
  text: string;
  /** Placeholders that had nothing to put in; the text ends with a line that says so. */
  empty: QuickPlaceholder[];
  /** Values that were cut to fit. */
  truncated: QuickPlaceholder[];
};

/** Fill a template. Missing values become empty text and the message names what was missing, so the model is not left guessing. */
export function renderQuickTask(template: string, values: Partial<Record<QuickPlaceholder, string | undefined | null>>, notes: { empty: (names: string) => string; truncated: string }): RenderedTask {
  const empty: QuickPlaceholder[] = [];
  const truncated: QuickPlaceholder[] = [];
  let body = "";
  for (const token of tokenize(template)) {
    if (token.kind === "text") { body += token.text; continue; }
    const name = token.name as QuickPlaceholder;
    if (!(QUICK_PLACEHOLDERS as readonly string[]).includes(name)) { body += `{${token.name}}`; continue; }
    let value = values[name]?.toString() ?? "";
    if (!value.trim()) {
      if (!empty.includes(name)) empty.push(name);
      value = "";
    } else if (value.length > QUICK_VALUE_MAX) {
      value = `${value.slice(0, QUICK_VALUE_MAX)}…${notes.truncated}`;
      if (!truncated.includes(name)) truncated.push(name);
    }
    body += value;
  }
  const lines = [body.trim()];
  if (empty.length) lines.push(notes.empty(empty.join("、")));
  return { text: lines.filter(Boolean).join("\n\n"), empty, truncated };
}

/** The tasks every profile starts with. They can be edited or removed, and "restore defaults" brings them back as written here. */
export const BUILTIN_QUICK_TASKS: ReadonlyArray<Omit<QuickTask, "id" | "builtin" | "order" | "enabled"> & { builtinKey: string }> = [
  { builtinKey: "summarize-page", name: "总结这一页", template: "请总结当前这一页的内容。", pages: ["comic"], includeFrame: false, includeLibrary: false, sendMode: "send" },
  { builtinKey: "read-text", name: "识别这一页的文字", template: "请识别并逐字抄录当前页面上的文字，认不准的地方请标出来。", pages: ["comic"], includeFrame: true, includeLibrary: false, sendMode: "send" },
  { builtinKey: "recap", name: "总结到现在的剧情", template: "请根据已提供的字幕，总结到当前位置为止发生的剧情，不要透露之后的内容。", pages: ["video"], includeFrame: false, includeLibrary: false, sendMode: "send" },
  { builtinKey: "explain-line", name: "解释最近的台词", template: "请解释最近一两句台词的含义和语境，只依据已提供的字幕。", pages: ["video"], includeFrame: false, includeLibrary: false, sendMode: "send" },
  { builtinKey: "describe-frame", name: "描述当前画面", template: "请描述当前画面里能看到的内容，看不清的地方直说。", pages: ["video"], includeFrame: true, includeLibrary: false, sendMode: "send" },
  { builtinKey: "interval", name: "这一段在讲什么", template: "请概述我选定的这个区间里发生了什么，只依据已提供的字幕。", pages: ["video"], includeFrame: false, includeLibrary: false, sendMode: "send" },
  { builtinKey: "read-so-far", name: "总结我读过的部分", template: "请只根据我已经读过的范围，总结这部作品到目前为止的内容。", pages: ["novel"], includeFrame: false, includeLibrary: false, sendMode: "send" },
  { builtinKey: "library", name: "我最近在看什么", template: "请根据已提供的作品摘要，说说我最近在看什么、各自看到哪里了。", pages: ["library", "chat"], includeFrame: false, includeLibrary: true, sendMode: "send" },
];
