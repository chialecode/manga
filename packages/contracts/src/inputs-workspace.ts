import { z } from "zod";
import { MetadataProviderIdSchema } from "./media.ts";
import { QuickTaskDraftSchema, QUICK_PAGES } from "./quick-tasks.ts";
import { FIND_PER_TYPE_MAX, FIND_QUERY_MAX, OBJECT_KINDS, RailViewSchema, SIDEBAR_GROUP_SHOWN, SIDEBAR_PAGE_MAX, SidebarItemTypeSchema, itemTypeOfView } from "./sidebar.ts";
import { ContextIdSchema, WorkspaceStateSchema } from "./workspace-state.ts";

const id = z.string().min(1).max(256);
const iso = z.string().min(10).max(40);
const kind = z.enum(["novel", "comic", "video"]);

/** Library paths and the background scan (A-50). Adding or removing a path comes from the interface only: the model never supplies a path. */
export const SCAN_INTERVAL_MINUTES = [0, 30, 60, 360, 1440] as const;

/**
 * Input schemas for the workspace commands: library paths and scans, previews and characters from a linked source,
 * quick tasks, the operation log, usage, records, the message stream of a session and the context debug panel.
 */
export const WorkspaceCommandInputs = {
  /** The projects and "最近" with their conversation counts, tab counts and last activity (A-94). Archived projects are listed only when asked for. */
  "workspace.contexts": z.object({ includeArchived: z.boolean().optional() }).strict(),
  /** The saved tabs and split layout of one context; a context that was never arranged answers with the empty state. */
  "workspace.loadContext": z.object({ contextId: ContextIdSchema }).strict(),
  /** Saves them. A state over the size limit is cut to it (the oldest closed tabs, then the view state of tabs that are not focused) and the answer says so. */
  "workspace.saveContext": z.object({ contextId: ContextIdSchema, state: WorkspaceStateSchema }).strict(),
  /** Where the person is when the application is left, so the next start comes back to it. */
  "workspace.setLastContext": z.object({ contextId: ContextIdSchema }).strict(),
  /**
   * What the sidebar lists for one view of the icon rail (A-99): the projects and "最近", each with how many things of the kind it holds (the home: of every
   * kind, the kinds with something in them) and the first few of them. `open` names the groups whose things are wanted (a group that is not named answers
   * with its count only); without it every group answers in full. The downloads are not kept in a project and answer as one list.
   */
  "workspace.sidebar": z.object({
    view: RailViewSchema,
    perGroup: z.number().int().min(1).max(20).default(SIDEBAR_GROUP_SHOWN),
    open: z.array(ContextIdSchema).max(600).optional(),
  }).strict(),
  /** More of one list of the sidebar: the things of one kind in one context, a page at a time. `type` is needed on the home, where a context holds several kinds. */
  "workspace.items": z.object({
    view: RailViewSchema,
    contextId: ContextIdSchema,
    type: SidebarItemTypeSchema.optional(),
    limit: z.number().int().min(1).max(SIDEBAR_PAGE_MAX).default(20),
    cursor: z.string().min(1).max(200).optional(),
  }).strict().refine((value) => {
    const own = itemTypeOfView(value.view);
    if (own) return value.type === undefined || value.type === own;
    return value.view === "downloads" ? value.type === undefined : value.type !== undefined;
  }, { message: "the home needs the kind of the list; the other views have their own" }),
  /** The whiteboards, maps, drafts or cuts of every project, newest first, for the management tab of each. `q` narrows by name. */
  "workspace.objects": z.object({
    kind: z.enum(OBJECT_KINDS),
    q: z.string().min(1).max(FIND_QUERY_MAX).optional(),
    limit: z.number().int().min(1).max(SIDEBAR_PAGE_MAX).default(50),
    offset: z.number().int().nonnegative().max(1_000_000).default(0),
  }).strict(),
  /** The things whose name has the text in it, by kind, a few of each (the search box's instant results). `view` narrows to the kind of one view. */
  "workspace.find": z.object({
    q: z.string().min(1).max(FIND_QUERY_MAX),
    view: RailViewSchema.optional(),
    perType: z.number().int().min(1).max(FIND_PER_TYPE_MAX).default(4),
  }).strict(),
  "library.paths.list": z.object({}).strict(),
  "library.paths.add": z.object({ pathHandle: id, mediaKind: kind, autoScan: z.boolean().optional() }).strict(),
  "library.paths.update": z.object({ pathId: id, mediaKind: kind.optional(), autoScan: z.boolean().optional(), pathHandle: id.optional() }).strict(),
  "library.paths.remove": z.object({ pathId: id }).strict(),
  /** The folder downloads are published into when the person has not chosen one: a library path of its own under the downloads location (A-69). */
  "library.paths.ensureDownloads": z.object({ mediaKind: kind }).strict(),
  "library.scan.start": z.object({ pathId: id.optional() }).strict(),
  "library.scan.cancel": z.object({ jobId: id.optional(), pathId: id.optional() }).strict(),
  "library.scan.status": z.object({}).strict(),
  "library.scan.setSchedule": z.object({
    onStartup: z.boolean(),
    intervalMinutes: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(360), z.literal(1440)]),
  }).strict(),

  "metadata.resolveRef": z.object({ ref: z.string().max(512), workId: id.optional(), providerId: MetadataProviderIdSchema.optional() }).strict(),
  "metadata.preview": z.object({ workId: id, providerId: MetadataProviderIdSchema.optional(), externalId: z.string().min(1).max(64).optional() }).strict(),
  "metadata.characters": z.object({ workId: id }).strict(),

  "quickTasks.list": z.object({ page: z.enum(QUICK_PAGES).optional(), includeDisabled: z.boolean().optional() }).strict(),
  "quickTasks.save": QuickTaskDraftSchema,
  "quickTasks.delete": z.object({ id }).strict(),
  "quickTasks.reorder": z.object({ ids: z.array(id).min(1).max(200) }).strict(),
  "quickTasks.restore": z.object({ builtinKey: z.string().min(1).max(64).optional() }).strict(),

  "log.query": z.object({
    category: z.string().min(1).max(64).optional(),
    actorKind: z.enum(["user", "agent", "system"]).optional(),
    outcome: z.enum(["ok", "error"]).optional(),
    q: z.string().min(1).max(128).optional(),
    from: iso.optional(),
    to: iso.optional(),
    limit: z.number().int().positive().max(200).optional(),
    before: z.number().int().positive().optional(),
  }).strict(),
  "usage.query": z.object({
    from: iso.optional(),
    to: iso.optional(),
    modelId: z.string().min(1).max(128).optional(),
    limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().max(1_000_000).optional(),
  }).strict(),
  "records.list": z.object({
    type: z.enum(["all", "note", "recording"]).optional(),
    workId: id.optional(),
    mediaKind: kind.optional(),
    state: z.string().min(1).max(32).optional(),
    q: z.string().min(1).max(128).optional(),
    deleted: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().nonnegative().max(1_000_000).optional(),
  }).strict(),
  "notes.delete": z.object({ objectId: id }).strict(),
  "notes.undelete": z.object({ objectId: id }).strict(),
  "session.stream": z.object({ sessionId: id, limit: z.number().int().positive().max(1000).optional(), before: iso.optional() }).strict(),
  "debug.context": z.object({
    sessionId: id.optional(),
    resourceId: id.optional(),
    workId: id.optional(),
    page: z.string().min(1).max(32).optional(),
  }).strict(),
};
