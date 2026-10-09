import { MangaError } from "@manga/contracts";
import { effectiveProfile, type ModelProfile } from "@manga/contracts/models";
import type { ChatMessage, ToolDefinition } from "@manga/model-protocol";

/**
 * The context of an agent run, counted in tokens (A-82). Both runtimes build the request from the same messages, so one budget and one way of making things fit
 * serves both: older tool results are cut down first, then the older conversation is replaced by a summary the model itself writes. The estimate is made without
 * the model's own tokenizer and leans high; once a service reports how many tokens it counted, later estimates are scaled by what it said.
 */

/** Tokens a picture costs: the services bill a picture by its size in tiles, around a thousand for the sizes a task carries. */
const IMAGE_TOKENS = 1100;
/** What the framing of one message costs: its role and separators. */
const MESSAGE_OVERHEAD = 4;

/** An estimate of the tokens in a text: a token holds about three and a half letters of Latin text and about one Chinese, Japanese or Korean character. */
export function estimateTokens(text: string): number {
  let narrow = 0;
  let wide = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 128) narrow += 1;
    else wide += 1;
  }
  return Math.ceil(narrow / 3.5 + wide);
}

export function messageTokens(message: ChatMessage): number {
  let sum = MESSAGE_OVERHEAD + estimateTokens(message.content);
  for (const call of message.toolCalls ?? []) sum += estimateTokens(call.name) + estimateTokens(call.arguments) + MESSAGE_OVERHEAD;
  sum += (message.images?.length ?? 0) * IMAGE_TOKENS;
  return sum;
}

export function toolsTokens(tools: readonly ToolDefinition[] | undefined): number {
  return (tools ?? []).reduce((sum, tool) => sum + estimateTokens(tool.name) + estimateTokens(tool.description) + estimateTokens(JSON.stringify(tool.parameters)) + MESSAGE_OVERHEAD, 0);
}

export function contextTokens(messages: readonly ChatMessage[], tools?: readonly ToolDefinition[], calibration = 1): number {
  return Math.ceil((messages.reduce((sum, message) => sum + messageTokens(message), 0) + toolsTokens(tools)) * calibration);
}

/** The first part of a text that fits in a number of tokens, cut at a character and not in the middle of one. */
export function truncateToTokens(text: string, tokens: number): { text: string; cut: boolean } {
  if (tokens <= 0) return { text: "", cut: text.length > 0 };
  if (estimateTokens(text) <= tokens) return { text, cut: false };
  const chars = [...text];
  // The estimate is monotonic, so a bisection finds the longest prefix that fits.
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(chars.slice(0, mid).join("")) <= tokens) low = mid;
    else high = mid - 1;
  }
  return { text: chars.slice(0, low).join(""), cut: true };
}

/** The last part of a text that fits in a number of tokens; what a summary of a conversation reads when the whole of it is too long. */
export function tailToTokens(text: string, tokens: number): string {
  if (tokens <= 0) return "";
  if (estimateTokens(text) <= tokens) return text;
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(chars.slice(chars.length - mid).join("")) <= tokens) low = mid;
    else high = mid - 1;
  }
  return `（更早的部分已省略）\n${chars.slice(chars.length - low).join("")}`;
}

export type Budget = {
  contextWindow: number;
  /** What the request may hold: the window less the answer and a margin. */
  contextTokens: number;
  maxOutputTokens: number;
  margin: number;
};

/** The margin kept free of the window: a twentieth of it, and at least four thousand tokens. */
export const marginOf = (contextWindow: number): number => Math.max(Math.ceil(contextWindow * 0.05), 4_000);

export function budgetOf(profile: Pick<ModelProfile, "contextWindow" | "maxOutput">): Budget {
  const margin = marginOf(profile.contextWindow);
  // A profile whose answer and margin leave nothing still gets a quarter of its window, or the task could never start.
  const room = Math.max(profile.contextWindow - profile.maxOutput - margin, Math.floor(profile.contextWindow / 4), 1_024);
  return { contextWindow: profile.contextWindow, contextTokens: room, maxOutputTokens: profile.maxOutput, margin };
}

/** The budget of a stored connection row. */
export const budgetOfConnection = (row: { profile_json?: string | null; verified_capabilities_json?: string | null }): { profile: ModelProfile; budget: Budget } => {
  let verified: string[] = [];
  try { verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[]; } catch { /* none verified */ }
  const profile = effectiveProfile(row.profile_json, verified);
  return { profile, budget: budgetOf(profile) };
};

/** What the person is told when a task cannot be made to fit; the way out is in the sentence. */
export const advice = "可以换一个上下文窗口更大的模型、开一个新对话，或者减少附带的材料。";

export const tooLargeError = (tokens: number, budget: Budget): MangaError => new MangaError(
  "BUDGET_EXCEEDED",
  `这次任务需要的上下文约 ${tokens} 个 Token，超过了模型可用的 ${budget.contextTokens} 个（窗口 ${budget.contextWindow}，已减去答复与余量）。材料和问题本身就放不下，压缩也帮不上忙。${advice}`,
  { details: { reason: "context_too_large", tokens, budgetTokens: budget.contextTokens, contextWindow: budget.contextWindow } },
);

export const compactionFailedError = (attempts: number): MangaError => new MangaError(
  "BUDGET_EXCEEDED",
  `上下文超出了模型的预算，把较早的对话压缩成摘要时连续失败了 ${attempts} 次，任务只好停下。${advice}`,
  { details: { reason: "compaction_failed", attempts } },
);

const NOTE = (original: number) => `\n…（工具结果太长，已截短；原有 ${original} 个字符）`;

/**
 * Cut the old tool results down, a little at a time, until the context fits: the newest few are left whole, because the model is working with them. What still
 * does not fit is dealt with after the conversation has been summarized.
 */
const TRIM_LEVELS = [
  { keep: 3, chars: 2_000 },
  { keep: 2, chars: 800 },
] as const;

function trimmed(messages: readonly ChatMessage[], keep: number, chars: number): { messages: ChatMessage[]; count: number } {
  const toolIndexes = messages.flatMap((message, index) => (message.role === "tool" ? [index] : []));
  const protectedFrom = toolIndexes.length - keep;
  let count = 0;
  const out = messages.map((message, index) => {
    if (message.role !== "tool") return message;
    const position = toolIndexes.indexOf(index);
    if (position >= protectedFrom && keep > 0) return message;
    const text = [...message.content];
    if (text.length <= chars) return message;
    count += 1;
    return { ...message, content: `${text.slice(0, chars).join("")}${NOTE(text.length)}` };
  });
  return { messages: out, count };
}

/** The messages a summary may replace: everything but the system messages, the task itself (the last user message) and the newest exchange of tool calls. */
function compressible(messages: readonly ChatMessage[]): number[] {
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  let tail = messages.length;
  for (let index = messages.length - 1; index > lastUser; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) { tail = index; break; }
    if (message.role !== "tool") { tail = index; break; }
    tail = index;
  }
  return messages.flatMap((message, index) => (message.role !== "system" && index !== lastUser && index < tail ? [index] : []));
}

/** The conversation as plain text, for the model to summarize. Tool results are cut again here so the request itself fits. */
export function transcriptOf(messages: readonly ChatMessage[], maxChars = 24_000): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") lines.push(`用户：${message.content}`);
    else if (message.role === "assistant") {
      if (message.content) lines.push(`助手：${message.content}`);
      for (const call of message.toolCalls ?? []) lines.push(`助手调用工具 ${call.name}：${[...call.arguments].slice(0, 400).join("")}`);
    } else if (message.role === "tool") lines.push(`工具返回：${[...message.content].slice(0, 1_200).join("")}`);
  }
  const text = lines.join("\n");
  const chars = [...text];
  // Too much even so: keep the end, which is the part the rest of the task leans on.
  return chars.length > maxChars ? `（更早的部分已省略）\n${chars.slice(chars.length - maxChars).join("")}` : text;
}

export const COMPACTION_PROMPT = "请把下面这段较早的对话（包括工具调用与结果）压缩成一份摘要，供同一个任务继续使用。保留：用户的目标与已经做出的决定、已经查到的事实（作品、资源、修订、数字、原文中的关键句）、尚未完成的事项。去掉寒暄与重复。用中文，条目式，不要超过 600 字，不要添加对话里没有的内容。";

export const SUMMARY_MARK = "【较早对话的摘要】";

export type CompactionInfo = { replaced: number; attempts: number; tokensBefore: number; tokensAfter: number; summaryTokens: number };
export type Fit = {
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  /** How many tool results were cut down. */
  trimmed: number;
  compacted: CompactionInfo | null;
};

/**
 * Make the messages fit the budget. They are returned untouched when they already do. Otherwise old tool results are cut down; when that is not enough the
 * older conversation becomes one summary written by `summarize`, which is tried up to `attempts` times in a row before the task is stopped with the reason.
 * `summarize` is given the conversation as text and the number of the attempt, and returns the summary.
 */
export async function fitContext(input: {
  messages: ChatMessage[];
  tools?: readonly ToolDefinition[];
  budget: Budget;
  /** What an earlier answer's own count said about the estimates: counted tokens divided by estimated ones. */
  calibration?: number;
  summarize: (transcript: string, attempt: number) => Promise<string>;
  attempts?: number;
}): Promise<Fit> {
  const calibration = input.calibration ?? 1;
  const limit = input.budget.contextTokens;
  const size = (messages: readonly ChatMessage[]) => contextTokens(messages, input.tools, calibration);
  const before = size(input.messages);
  if (before <= limit) return { messages: input.messages, tokensBefore: before, tokensAfter: before, trimmed: 0, compacted: null };

  let messages = input.messages;
  let trimmedCount = 0;
  // 1. The old tool results, a little at a time.
  for (const level of TRIM_LEVELS) {
    const next = trimmed(messages, level.keep, level.chars);
    messages = next.messages;
    trimmedCount += next.count;
    if (size(messages) <= limit) return { messages, tokensBefore: before, tokensAfter: size(messages), trimmed: trimmedCount, compacted: null };
  }

  // 2. The older conversation, as one summary.
  let compacted: CompactionInfo | null = null;
  const indexes = compressible(messages);
  if (indexes.length > 0) {
    const attempts = input.attempts ?? 3;
    const transcript = transcriptOf(indexes.map((index) => messages[index]!));
    let summary = "";
    let used = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      used = attempt;
      try {
        summary = (await input.summarize(transcript, attempt)).trim();
      } catch (error) {
        // A cancelled run is not a failure of the summary.
        if (error instanceof MangaError && error.code === "CANCELLED") throw error;
        summary = "";
      }
      if (summary) break;
    }
    if (!summary) throw compactionFailedError(used);
    const first = indexes[0]!;
    const drop = new Set(indexes);
    const message: ChatMessage = { role: "system", content: `${SUMMARY_MARK}\n${summary}` };
    messages = messages.flatMap((entry, index) => (index === first ? [message] : drop.has(index) ? [] : [entry]));
    compacted = { replaced: indexes.length, attempts: used, tokensBefore: before, tokensAfter: size(messages), summaryTokens: messageTokens(message) };
  }
  if (size(messages) <= limit) return { messages, tokensBefore: before, tokensAfter: size(messages), trimmed: trimmedCount, compacted };

  // 3. What is left is the task, the newest results and the material. The biggest of the results and the material is cut, and only by what is missing, with the cut said
  // in the text, until it fits. The question and the summary are never cut: a task whose question and what must stay do not fit is stopped with the reason.
  for (let round = 0; round < 64 && size(messages) > limit; round += 1) {
    let target = -1;
    let targetTokens = MIN_KEEP_TOKENS;
    messages.forEach((message, index) => {
      const cuttable = message.role === "tool" || (message.role === "system" && !message.content.startsWith(SUMMARY_MARK));
      const tokens = estimateTokens(message.content);
      if (cuttable && tokens > targetTokens) { target = index; targetTokens = tokens; }
    });
    if (target < 0) break;
    const cut = messages[target]!;
    const note = cut.role === "tool" ? NOTE([...cut.content].length) : CUT_NOTE;
    const keep = Math.max(MIN_KEEP_TOKENS, targetTokens - (size(messages) - limit) - estimateTokens(note) - 8);
    messages = messages.map((message, index) => (index === target ? { ...message, content: `${truncateToTokens(message.content, keep).text}${note}` } : message));
    trimmedCount += 1;
  }
  if (size(messages) <= limit) return { messages, tokensBefore: before, tokensAfter: size(messages), trimmed: trimmedCount, compacted };
  throw tooLargeError(size(messages), input.budget);
}

/** The least a result or the material keeps when it is cut; below this it is no use and the task is stopped instead. */
const MIN_KEEP_TOKENS = 256;
const CUT_NOTE = "\n\n（材料超出长度预算，后面的部分没有提供。）";

/** How much to scale the estimates by, from an answer that counted its own input: the ratio of what it counted to what was estimated, kept within reason and smoothed. */
export function calibrate(previous: number, counted: number | undefined, estimated: number): number {
  if (!counted || counted <= 0 || estimated <= 0) return previous;
  const ratio = Math.min(2, Math.max(0.6, counted / estimated));
  return Math.round((previous * 0.5 + ratio * 0.5) * 1000) / 1000;
}
