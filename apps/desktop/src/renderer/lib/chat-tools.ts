import type { MessageKey, Translator } from "@manga/i18n";

type T = Translator["t"];

const TOOL_KEY_MAP: Record<string, MessageKey> = {
  "library.find": "chat.tool.name.library_find",
  "library.search": "chat.tool.name.library_search",
  "library.list": "chat.tool.name.library_list",
  "library.read": "chat.tool.name.library_read",
  "library.readSlice": "chat.tool.name.library_read",
  "notes.list": "chat.tool.name.notes_list",
  "notes.get": "chat.tool.name.notes_get",
  "notes.create": "chat.tool.name.notes_create",
  "notes.update": "chat.tool.name.notes_update",
  "web.search": "chat.tool.name.web_search",
  "webpage.fetch": "chat.tool.name.webpage_fetch",
  "metadata.search": "chat.tool.name.metadata_search",
  "semantic.search": "chat.tool.name.semantic_search",
  "ocr.recognize": "chat.tool.name.ocr_recognize",
};

/** Maps internal MANGA tool/command names into localized Chinese display labels (never renders raw internal IDs). */
export function localizedToolName(t: T, name: string): string {
  const direct = TOOL_KEY_MAP[name];
  if (direct) return t(direct);
  if (name.startsWith("whiteboard.")) return t("chat.tool.name.whiteboard");
  if (name.startsWith("mindmap.")) return t("chat.tool.name.mindmap");
  if (name.startsWith("proposal.")) return t("chat.tool.name.proposal");
  if (name.startsWith("notes.")) return t("chat.tool.name.notes_update");
  if (name.startsWith("library.")) return t("chat.tool.name.library_read");
  return t("chat.tool.name.other");
}
