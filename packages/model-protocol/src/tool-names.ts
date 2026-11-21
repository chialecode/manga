import type { ChatMessage, StreamEvent, TextRequest } from "./http.ts";

/** What the OpenAI-style protocols (and DeepSeek, strictly) accept as a function name. MANGA's command ids have dots (`library.find`), which they refuse. */
const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export type ToolNames = { wire: (name: string) => string; local: (name: string) => string };

/**
 * The names a request's tools go by on the wire, and back. A name the service accepts is sent as it is; any other gets its other characters turned into
 * `_` (cut to 64), with a number added when that would meet another name. A name the service answers with that is not in the table is kept as it came, so
 * the caller's own check of unknown tools still sees it.
 */
export function toolNamesOf(request: Pick<TextRequest, "tools" | "messages">): ToolNames {
  const names = new Set<string>();
  for (const tool of request.tools ?? []) names.add(tool.name);
  for (const message of request.messages) for (const call of message.toolCalls ?? []) names.add(call.name);
  const toWire = new Map<string, string>();
  const toLocal = new Map<string, string>();
  // The names that are already fine keep them, so a renamed one never takes a name a tool has.
  for (const name of names) if (WIRE_NAME.test(name)) { toWire.set(name, name); toLocal.set(name, name); }
  for (const name of names) {
    if (toWire.has(name)) continue;
    const base = (name.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool").slice(0, 64);
    let wire = base;
    for (let n = 2; toLocal.has(wire); n += 1) wire = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
    toWire.set(name, wire);
    toLocal.set(wire, name);
  }
  return { wire: (name) => toWire.get(name) ?? name, local: (name) => toLocal.get(name) ?? name };
}

/** The request as it goes out: its tools, and the calls of the assistant messages sent back, under their wire names. */
export function toWireRequest(request: TextRequest, names: ToolNames): TextRequest {
  if (!request.tools?.length && !request.messages.some((message) => message.toolCalls?.length)) return request;
  const messages: ChatMessage[] = request.messages.map((message) => (message.toolCalls?.length
    ? { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call, name: names.wire(call.name) })) }
    : message));
  return { ...request, messages, ...(request.tools ? { tools: request.tools.map((tool) => ({ ...tool, name: names.wire(tool.name) })) } : {}) };
}

/** The events of a stream with the tools' own names back in them. */
export async function* withLocalToolNames(events: AsyncGenerator<StreamEvent>, names: ToolNames): AsyncGenerator<StreamEvent> {
  for await (const event of events) yield event.type === "tool-call-delta" ? { ...event, name: names.local(event.name) } : event;
}
