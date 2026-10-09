import { z } from "zod";

const id = z.string().min(1).max(256);
const finite = z.number().finite();
const coordinate = finite.min(-1_000_000).max(1_000_000);
const size = finite.min(16).max(20_000);

/** What a board or map can hold a reference to, and what can sit inside another object (CRE-04). */
export const EMBED_KINDS = ["note", "whiteboard", "mindmap"] as const;
export type EmbedKind = (typeof EMBED_KINDS)[number];
export const REF_KINDS = ["work", "resource", "anchor", "note", "recording", "excerpt", "whiteboard", "mindmap", "draft", "roughcut", "screenshot"] as const;
export const EMBED_MODES = ["live", "snapshot"] as const;
export const EMBED_STATES = ["valid", "deleted", "disabled", "denied", "cycle"] as const;
export type EmbedState = (typeof EMBED_STATES)[number];

export const WHITEBOARD_NODE_KINDS = ["text", "card", "ref", "group"] as const;
export type WhiteboardNodeKind = (typeof WHITEBOARD_NODE_KINDS)[number];
export const MINDMAP_THEMES = ["pink", "blue", "green", "mono"] as const;
export const ALIGN_MODES = ["left", "right", "top", "bottom", "hcenter", "vcenter"] as const;

/** Where inside the target a reference points: a block of a note, a node of a board or a map. Nothing means the whole object. */
export const LocatorSchema = z.object({ blockId: id.optional(), nodeId: id.optional() }).strict();
export type CanvasLocator = z.infer<typeof LocatorSchema>;

const NodeData = z.record(z.string(), z.unknown()).refine((value) => JSON.stringify(value).length <= 20_000, { message: "node data is too large" });

/** One step of an edit of a whiteboard. All steps of a call are one change: one undo takes all of them back. */
export const WhiteboardAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("addNode"), id: id.optional(), kind: z.enum(WHITEBOARD_NODE_KINDS), x: coordinate, y: coordinate, w: size.optional(), h: size.optional(), data: NodeData.optional(), parentId: id.nullable().optional() }).strict(),
  z.object({ type: z.literal("moveNodes"), moves: z.array(z.object({ id, x: coordinate, y: coordinate }).strict()).min(1).max(5000) }).strict(),
  z.object({ type: z.literal("resizeNode"), id, w: size, h: size, x: coordinate.optional(), y: coordinate.optional() }).strict(),
  z.object({ type: z.literal("updateNode"), id, data: NodeData }).strict(),
  z.object({ type: z.literal("deleteNodes"), ids: z.array(id).min(1).max(5000) }).strict(),
  z.object({ type: z.literal("addEdge"), id: id.optional(), sourceId: id, targetId: id, label: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal("updateEdge"), id, label: z.string().max(200) }).strict(),
  z.object({ type: z.literal("deleteEdges"), ids: z.array(id).min(1).max(5000) }).strict(),
  z.object({ type: z.literal("group"), ids: z.array(id).min(1).max(5000), title: z.string().max(200).optional(), groupId: id.optional() }).strict(),
  z.object({ type: z.literal("ungroup"), id }).strict(),
  z.object({ type: z.literal("setGroup"), ids: z.array(id).min(1).max(5000), groupId: id.nullable() }).strict(),
  z.object({ type: z.literal("align"), ids: z.array(id).min(2).max(5000), mode: z.enum(ALIGN_MODES) }).strict(),
  z.object({ type: z.literal("distribute"), ids: z.array(id).min(3).max(5000), axis: z.enum(["h", "v"]) }).strict(),
  z.object({ type: z.literal("arrange"), ids: z.array(id).min(2).max(5000), columns: z.number().int().min(1).max(50).optional(), gap: finite.min(0).max(500).optional() }).strict(),
  z.object({ type: z.literal("order"), ids: z.array(id).min(1).max(5000), to: z.enum(["front", "back"]) }).strict(),
]);
export type WhiteboardActionInput = z.infer<typeof WhiteboardAction>;

export const MindmapAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("addChild"), parentId: id, id: id.optional(), text: z.string().max(2000).optional(), index: z.number().int().min(0).max(100000).optional() }).strict(),
  z.object({ type: z.literal("addSibling"), nodeId: id, id: id.optional(), text: z.string().max(2000).optional(), before: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("setText"), nodeId: id, text: z.string().max(2000) }).strict(),
  z.object({ type: z.literal("move"), nodeId: id, parentId: id, index: z.number().int().min(0).max(100000).optional() }).strict(),
  z.object({ type: z.literal("shift"), nodeId: id, direction: z.enum(["up", "down"]) }).strict(),
  z.object({ type: z.literal("delete"), nodeId: id }).strict(),
  z.object({ type: z.literal("collapse"), nodeId: id, collapsed: z.boolean() }).strict(),
  z.object({ type: z.literal("addRef"), nodeId: id, kind: z.enum(REF_KINDS), targetId: id, locator: LocatorSchema.optional(), label: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal("removeRef"), nodeId: id, refId: id }).strict(),
]);
export type MindmapActionInput = z.infer<typeof MindmapAction>;

/** Boards, maps and the embeds between notes, boards and maps. */
export const CanvasCommandInputs = {
  "whiteboard.list": z.object({ projectId: id.optional() }).strict(),
  "whiteboard.create": z.object({ projectId: id, title: z.string().trim().min(1).max(200) }).strict(),
  "whiteboard.get": z.object({ boardId: id }).strict(),
  "whiteboard.rename": z.object({ boardId: id, title: z.string().trim().min(1).max(200) }).strict(),
  "whiteboard.delete": z.object({ boardId: id }).strict(),
  "whiteboard.edit": z.object({ boardId: id, label: z.string().max(80).optional(), actions: z.array(WhiteboardAction).min(1).max(200) }).strict(),
  "whiteboard.setViewport": z.object({ boardId: id, viewport: z.object({ x: coordinate, y: coordinate, zoom: finite.min(0.05).max(8) }).strict() }).strict(),
  "whiteboard.undo": z.object({ boardId: id }).strict(),
  "whiteboard.redo": z.object({ boardId: id }).strict(),

  "mindmap.list": z.object({ projectId: id.optional() }).strict(),
  "mindmap.create": z.object({ projectId: id, title: z.string().trim().min(1).max(200), rootText: z.string().max(2000).optional() }).strict(),
  "mindmap.get": z.object({ mapId: id }).strict(),
  "mindmap.rename": z.object({ mapId: id, title: z.string().trim().min(1).max(200) }).strict(),
  "mindmap.delete": z.object({ mapId: id }).strict(),
  "mindmap.setTheme": z.object({ mapId: id, theme: z.enum(MINDMAP_THEMES) }).strict(),
  "mindmap.edit": z.object({ mapId: id, label: z.string().max(80).optional(), actions: z.array(MindmapAction).min(1).max(200) }).strict(),
  "mindmap.undo": z.object({ mapId: id }).strict(),
  "mindmap.redo": z.object({ mapId: id }).strict(),
  /** Text formats are written by the app; an image is drawn by the page and handed over as `data` (base64 for PNG, the markup for SVG). */
  "mindmap.export": z.object({ mapId: id, format: z.enum(["png", "svg", "markdown", "opml"]), pathHandle: id, data: z.string().max(40_000_000).optional() }).strict(),

  "embed.list": z.object({ sourceKind: z.enum(EMBED_KINDS), sourceId: id }).strict(),
  "embed.upsert": z.object({
    sourceKind: z.enum(EMBED_KINDS), sourceId: id, slot: z.string().min(1).max(256),
    targetKind: z.enum(EMBED_KINDS), targetId: id, locator: LocatorSchema.optional(), mode: z.enum(EMBED_MODES).optional(),
  }).strict(),
  "embed.remove": z.object({ sourceKind: z.enum(EMBED_KINDS), sourceId: id, slot: z.string().min(1).max(256) }).strict(),
  "embed.refresh": z.object({ sourceKind: z.enum(EMBED_KINDS), sourceId: id, slot: z.string().min(1).max(256) }).strict(),
  "embed.backlinks": z.object({ targetKind: z.enum(EMBED_KINDS), targetId: id }).strict(),
};
