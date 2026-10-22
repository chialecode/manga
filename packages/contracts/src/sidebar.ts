import { z } from "zod";
import { ContextIdSchema } from "./workspace-state.ts";

/**
 * The views of the icon rail (A-99): each icon is a view of the sidebar that lists one kind of thing, grouped by project; the home lists everything of
 * every project. Settings is not one of them: it is a state of the shell, not a list (A-101).
 */
/** The icons a person may take out of the rail: every one but the home. */
export const HIDEABLE_RAIL_VIEWS = ["conversation", "novel", "comic", "video", "note", "whiteboard", "mindmap", "draft", "roughcut", "downloads"] as const;
export type HideableRailView = (typeof HIDEABLE_RAIL_VIEWS)[number];
export const RAIL_VIEWS = ["home", ...HIDEABLE_RAIL_VIEWS] as const;
export type RailView = (typeof RAIL_VIEWS)[number];
export const RailViewSchema = z.enum(RAIL_VIEWS);

/** The kinds of thing a project or "最近" lists in the sidebar. The home shows all of them, in this order. */
export const SIDEBAR_ITEM_TYPES = ["conversation", "novel", "comic", "video", "note", "whiteboard", "mindmap", "draft", "roughcut"] as const;
export type SidebarItemType = (typeof SIDEBAR_ITEM_TYPES)[number];
export const SidebarItemTypeSchema = z.enum(SIDEBAR_ITEM_TYPES);

/** The one kind a view lists; the home and the downloads have none (the home lists all kinds, the downloads are not kept in a project). */
export function itemTypeOfView(view: RailView): SidebarItemType | null {
  return (SIDEBAR_ITEM_TYPES as readonly string[]).includes(view) ? (view as SidebarItemType) : null;
}

/** Each group lists this many things before "更多" (A-94, 交互设计 2.10). */
export const SIDEBAR_GROUP_SHOWN = 5;
/** The most things one page of a list answers with. */
export const SIDEBAR_PAGE_MAX = 100;
/** The most characters of a name that is looked for, and how many things of one kind a name search answers with. */
export const FIND_QUERY_MAX = 128;
export const FIND_PER_TYPE_MAX = 10;

/** What opening a thing of the sidebar asks the workspace for (the opener of its kind). */
export const SIDEBAR_OPEN_KINDS = ["conversation", "work", "resource", "note", "whiteboard", "mindmap", "draft", "roughcut", "download", "project"] as const;
export const SidebarOpenSchema = z.object({
  kind: z.enum(SIDEBAR_OPEN_KINDS),
  id: z.string().min(1).max(256),
  /** For a resource: the work it belongs to. */
  workId: z.string().min(1).max(256).nullable().optional(),
  /** For a work or a resource: the medium (novel, comic, video). */
  mediaKind: z.string().min(1).max(32).nullable().optional(),
  /** For a conversation: a general one (continued from the history) or one about a book or a work. */
  general: z.boolean().optional(),
}).strict();
export type SidebarOpen = z.infer<typeof SidebarOpenSchema>;

/** One thing in a list: what it is called, where it opens, where it belongs, and what can be done to it. */
export const SidebarItemSchema = z.object({
  /** Stable among the items of a context: the same thing keeps its key while the list changes. */
  key: z.string().min(1).max(300),
  type: z.enum([...SIDEBAR_ITEM_TYPES, "download", "project"]),
  title: z.string(),
  /** A second line for the information card: the work of an episode, the state of a download. */
  detail: z.string().nullable(),
  open: SidebarOpenSchema,
  /** The context it opens in: a project id, null for "最近". For a download, which is in none, null. */
  contextId: ContextIdSchema,
  /** The name of that project; null for "最近" (and for a download). */
  contextName: z.string().nullable(),
  updatedAt: z.string().nullable(),
  /** A conversation with a task running. */
  running: z.boolean(),
  /** A material of a project (a work, a resource or a note): its id, so it can be taken out of the project. */
  materialId: z.string().nullable(),
}).strict();
export type SidebarItem = z.infer<typeof SidebarItemSchema>;

/** The things of one kind in one context: how many there are, the first of them (when the group is open) and where the rest start. */
export const SidebarSectionSchema = z.object({
  type: z.enum([...SIDEBAR_ITEM_TYPES, "download"]),
  total: z.number().int().nonnegative(),
  items: z.array(SidebarItemSchema),
  /** False when the group was not open: the count is there, the items are asked for when it is opened. */
  loaded: z.boolean(),
  nextCursor: z.string().nullable(),
}).strict();
export type SidebarSection = z.infer<typeof SidebarSectionSchema>;

export const SidebarGroupSchema = z.object({
  contextId: ContextIdSchema,
  kind: z.enum(["recent", "project"]),
  name: z.string(),
  sections: z.array(SidebarSectionSchema),
}).strict();
export type SidebarGroup = z.infer<typeof SidebarGroupSchema>;

/** The answer for one view: the projects and "最近" with what they hold of the kind (the home: of every kind), or the downloads. */
export const SidebarViewSchema = z.object({
  view: RailViewSchema,
  groups: z.array(SidebarGroupSchema),
  downloads: SidebarSectionSchema.nullable(),
}).strict();
export type SidebarView = z.infer<typeof SidebarViewSchema>;

/** A thing found by name: which kind, what it is called, where it belongs and where it opens. */
export const FIND_TYPES = ["project", ...SIDEBAR_ITEM_TYPES] as const;
export type FindType = (typeof FIND_TYPES)[number];
/** A thing found by name opens in `contextId` when it has one of its own (a conversation, a project's object, a project); the rest opens where the person is. */
export const FindItemSchema = SidebarItemSchema.omit({ contextId: true }).extend({ contextId: ContextIdSchema.optional() }).strict();
export type FindItem = z.infer<typeof FindItemSchema>;
export const FindGroupSchema = z.object({
  type: z.enum(FIND_TYPES),
  items: z.array(FindItemSchema),
}).strict();
export type FindGroup = z.infer<typeof FindGroupSchema>;

/** The projects' objects of one kind in a list of their own (the management tab of whiteboards, maps, drafts and cuts). */
export const OBJECT_KINDS = ["whiteboard", "mindmap", "draft", "roughcut"] as const;
export type ObjectListKind = (typeof OBJECT_KINDS)[number];
export const ObjectRowSchema = z.object({
  kind: z.enum(OBJECT_KINDS),
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  projectArchived: z.boolean(),
  updatedAt: z.string(),
}).strict();
export type ObjectRow = z.infer<typeof ObjectRowSchema>;

/** What the shell keeps of the rail and the settings (交互设计 2.2): not per context. */
export const RailPreferenceSchema = z.object({
  /** The icons the person took out of the rail; they are found again under "…". */
  hidden: z.array(z.enum(HIDEABLE_RAIL_VIEWS)).max(HIDEABLE_RAIL_VIEWS.length).default([]),
  /** The view the sidebar shows. */
  view: RailViewSchema.default("home"),
  /**
   * Per view, the groups that are open: "" is "最近", else a project id. A view that is not named has its default (最近 and the current context open); the
   * context on screen is open whatever is kept here.
   */
  open: z.partialRecord(RailViewSchema, z.array(z.string().max(256)).max(200)).default({}),
  /** The settings page the person was on last. */
  settingsPage: z.string().min(1).max(32).nullable().default(null),
}).strict();
export type RailPreference = z.infer<typeof RailPreferenceSchema>;
export const DEFAULT_RAIL_PREFERENCE: RailPreference = { hidden: [], view: "home", open: {}, settingsPage: null };

/** A change to it: what is named is replaced (a view named in `open` takes the list it is given), the rest is left alone. */
export const RailPatchSchema = z.object({
  hidden: z.array(z.enum(HIDEABLE_RAIL_VIEWS)).max(HIDEABLE_RAIL_VIEWS.length).optional(),
  view: RailViewSchema.optional(),
  open: z.partialRecord(RailViewSchema, z.array(z.string().max(256)).max(200)).optional(),
  settingsPage: z.string().min(1).max(32).nullable().optional(),
}).strict();
export type RailPatch = z.infer<typeof RailPatchSchema>;

/** What the rail's preference is after a patch: what the patch names replaces what was there; a view named in `open` takes its list, the other views keep theirs. */
export function applyRailPatch(current: RailPreference, patch: RailPatch | undefined): RailPreference {
  return {
    hidden: patch?.hidden ?? current.hidden,
    view: patch?.view ?? current.view,
    open: { ...current.open, ...patch?.open },
    settingsPage: patch?.settingsPage === undefined ? current.settingsPage : patch.settingsPage,
  };
}
