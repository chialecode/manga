import type { ObjectListKind } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";

/**
 * What the four kinds of a project's objects (a whiteboard, a map, a draft, a rough cut) are called to the commands and to the person: the sidebar makes
 * them, renames them and deletes them, and the management tab lists them, with the words each kind already has in its own tab.
 */
export type ObjectSpec = {
  list: string;
  create: string;
  rename: string;
  delete: string;
  /** The field that names the object in `rename` and `delete`. */
  idField: "boardId" | "mapId" | "draftId" | "cutId";
  /** The field of `list`'s answer that holds the objects, and the field of `create`'s that holds the new one. */
  listField: "boards" | "maps" | "drafts" | "cuts";
  createdField: "board" | "map" | "draft" | "cut";
  defaultTitle: MessageKey;
  confirm: MessageKey;
};

export const OBJECT_SPEC: Record<ObjectListKind, ObjectSpec> = {
  whiteboard: { list: "whiteboard.list", create: "whiteboard.create", rename: "whiteboard.rename", delete: "whiteboard.delete", idField: "boardId", listField: "boards", createdField: "board", defaultTitle: "whiteboard.defaultTitle", confirm: "whiteboard.deleteConfirm" },
  mindmap: { list: "mindmap.list", create: "mindmap.create", rename: "mindmap.rename", delete: "mindmap.delete", idField: "mapId", listField: "maps", createdField: "map", defaultTitle: "mindmap.defaultTitle", confirm: "mindmap.deleteConfirm" },
  draft: { list: "draft.list", create: "draft.create", rename: "draft.rename", delete: "draft.delete", idField: "draftId", listField: "drafts", createdField: "draft", defaultTitle: "draft.defaultTitle", confirm: "draft.deleteConfirm" },
  roughcut: { list: "roughcut.list", create: "roughcut.create", rename: "roughcut.rename", delete: "roughcut.delete", idField: "cutId", listField: "cuts", createdField: "cut", defaultTitle: "roughcut.defaultTitle", confirm: "roughcut.deleteConfirm" },
};
