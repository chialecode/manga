import { z } from "zod";
import { SourceLocatorSchema } from "./location.ts";
import { AgentMediaContextSchema, MediaCommandInputs } from "./inputs-media.ts";
import { ReworkCommandInputs } from "./inputs-rework.ts";
import { OrdinalSchema } from "./media.ts";
import { LOCATION_PARTITIONS } from "./paths.ts";
import { NoteBlockSchema, NOTE_TAG_MAX, ReadingStylePatchSchema, ShellPanelSchema } from "./reading.ts";

const bytes = z.array(z.number().int().min(0).max(255)).min(1).max(16 * 1024 * 1024);
const text = z.string().max(2 * 1024 * 1024);
const id = z.string().min(1).max(256);
export const CommandInputs = {
  "workspace.get": z.object({}).strict(),
  "library.importText": z.object({ title: id, bytes, encoding: z.enum(["utf-8", "utf-16le"]).optional() }).strict(),
  "library.importEpub": z.object({ title: id, bytes }).strict(),
  "library.importDocument": z.object({
    title: id,
    format: z.enum(["txt", "epub", "mobi", "pdf", "cbz", "auto"]).optional(),
    bytes: bytes.optional(),
    pathHandle: id.optional(),
    encoding: z.enum(["utf-8", "utf-16le"]).optional(),
    hosted: z.boolean().optional(),
    /** User's choice of media kind; the import result suggests one from the content when this is absent. */
    kind: z.enum(["novel", "comic", "video"]).optional(),
    /** Add the file to an existing work as one more volume or chapter instead of creating a work. */
    workId: id.optional(),
    ordinal: OrdinalSchema.optional(),
  }).strict().refine((value) => Boolean(value.bytes?.length) !== Boolean(value.pathHandle), {
    message: "provide either file bytes or a path handle",
  }),
  "library.read": z.object({ resourceId: id, revisionId: id.optional() }).strict(),
  "library.readOriginal": z.object({ resourceId: id, revisionId: id.optional() }).strict(),
  "library.readSlice": z.object({
    resourceId: id,
    revisionId: id.optional(),
    partId: id,
    start: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(8000).optional(),
  }).strict(),
  "library.rebuildIndex": z.object({}).strict(),
  "library.repairSource": z.object({ resourceId: id, pathHandle: id }).strict(),
  "library.search": z.object({
    text: z.string().max(512),
    readAllowlist: z.array(id).max(10000).optional(),
    resourceId: id.optional(),
    withinProgress: z.boolean().optional(),
  }).strict(),
  "notes.create": z.object({ title: id, text, resourceId: id.optional(), workId: id.optional(), resourceRevisionId: id.optional(), locator: SourceLocatorSchema.optional(), quoteText: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(64)).max(NOTE_TAG_MAX).optional() }).strict(),
  "notes.update": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id.optional(), text }).strict(),
  "notes.list": z.object({
    text: z.string().max(512).optional(),
    tag: z.string().min(1).max(64).optional(),
    resourceId: id.optional(),
    limit: z.number().int().positive().max(500).optional(),
  }).strict(),
  "notes.history": z.object({ objectId: id, limit: z.number().int().positive().max(100).optional() }).strict(),
  "notes.restore": z.object({ objectId: id, expectedRevision: z.number().int().positive(), revision: z.number().int().positive() }).strict(),
  "notes.tags": z.object({ objectId: id, expectedRevision: z.number().int().positive(), tags: z.array(z.string().min(1).max(64)).max(NOTE_TAG_MAX) }).strict(),
  "notes.insert": z.object({
    objectId: id,
    expectedRevision: z.number().int().positive(),
    atIndex: z.number().int().nonnegative(),
    blockType: z.enum(["paragraph", "heading", "list", "quote", "code", "plaintext"]),
    text: text.optional(),
    level: z.number().int().min(1).max(3).optional(),
    ordered: z.boolean().optional(),
  }).strict(),
  "notes.remove": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id }).strict(),
  "notes.setType": z.object({
    objectId: id,
    expectedRevision: z.number().int().positive(),
    blockId: id,
    blockType: z.enum(["paragraph", "heading", "list", "quote", "code", "plaintext"]),
    level: z.number().int().min(1).max(3).nullable().optional(),
    ordered: z.boolean().nullable().optional(),
  }).strict(),
  "notes.rename": z.object({ objectId: id, expectedRevision: z.number().int().positive(), title: z.string().max(512), tags: z.array(z.string().min(1).max(64)).max(NOTE_TAG_MAX).optional() }).strict(),
  "notes.asset": z.object({ resourceRevisionId: id, assetId: id }).strict(),
  "capture.save": z.object({ bytes, mimeType: z.enum(["audio/webm", "audio/webm;codecs=opus"]), metadata: z.record(z.string(), z.unknown()) }).strict(),
  "progress.set": z.object({
    resourceId: id,
    resourceRevisionId: id,
    locator: SourceLocatorSchema,
    consumed: z.boolean().optional(),
  }).strict(),
  "library.getResource": z.object({ resourceId: id }).strict(),
  "library.list": z.object({
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().max(512).optional(),
    query: z.string().max(256).optional(),
  }).strict(),
  "library.contextSnapshot": z.object({
    resourceId: id,
    resourceRevisionId: id,
    partId: id.optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  }).strict(),
  "library.exportPackage": z.object({ pathHandle: id.optional(), targetDir: z.string().min(1).optional(), includeCovers: z.boolean().optional() }).strict(),
  "library.cancelExport": z.object({}).strict(),
  "library.importPackage": z.object({ pathHandle: id.optional(), sourceDir: z.string().min(1).optional() }).strict(),
  "notes.get": z.object({ objectId: id }).strict(),
  "notes.split": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id, offset: z.number().int().nonnegative() }).strict(),
  "notes.merge": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id }).strict(),
  "notes.move": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id, toIndex: z.number().int().nonnegative() }).strict(),
  "notes.copy": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id }).strict(),
  "notes.replace": z.object({
    objectId: id,
    expectedRevision: z.number().int().positive(),
    title: id.optional(),
    tags: z.array(z.string().min(1).max(64)).max(NOTE_TAG_MAX).optional(),
    blocks: z.array(NoteBlockSchema).min(1).max(500),
  }).strict(),
  "notes.openSource": z.object({ objectId: id, blockId: id.optional() }).strict(),
  "reading.bookmarks": z.object({ resourceId: id.optional() }).strict(),
  "reading.setBookmark": z.object({
    resourceId: id,
    resourceRevisionId: id,
    label: z.string().max(160).optional(),
    locator: SourceLocatorSchema,
    bookmarkId: id.optional(),
  }).strict(),
  "reading.removeBookmark": z.object({ bookmarkId: id }).strict(),
  "source.card": z.object({ resourceId: id, resourceRevisionId: id.optional(), partId: id.optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(), anchorId: id.optional() }).strict(),
  "package.preview": z.object({ pathHandle: id.optional(), sourceDir: z.string().min(1).optional() }).strict(),
  "package.importResolved": z.object({
    pathHandle: id.optional(),
    sourceDir: z.string().min(1).optional(),
    strategy: z.enum(["skip", "replace", "duplicate"]),
    decisions: z.array(z.object({ kind: z.enum(["work", "resource", "resource_revision", "object", "anchor", "ref", "progress", "capture", "bookmark"]), id: id, action: z.enum(["skip", "replace", "duplicate"]) }).strict()).max(5000).optional(),
  }).strict(),
  "workspace.sessions": z.object({ mode: z.enum(["enthusiast", "creator"]).optional() }).strict(),
  "session.open": z.object({ kind: z.enum(["resource", "project", "note", "work"]), targetId: id, mode: z.enum(["enthusiast", "creator"]).optional(), sessionId: id.optional() }).strict(),
  "notes.embed": z.object({ objectId: id, expectedRevision: z.number().int().positive(), fromBlockId: id, targetId: id, targetKind: z.enum(["object", "anchor"]) }).strict(),
  "capture.stat": z.object({ attachmentId: id }).strict(),
  "capture.preparePlayback": z.object({ attachmentId: id }).strict(),
  "capture.markPlayback": z.object({ attachmentId: id, positionMs: z.number().nonnegative().max(24 * 60 * 60 * 1000) }).strict(),
  "metadata.confirm": z.object({ workId: id, providerId: id, externalId: id }).strict(),
  "reader.ui.present": z.object({}).strict(),
  "reader.resolveAnchor": z.object({ resourceRevisionId: id, locator: SourceLocatorSchema }).strict(),
  "metadata.query": z.object({ title: id, mode: z.enum(["single", "fallback", "multi"]), workId: id }).strict(),
  "metadata.override": z.object({ workId: id, fields: z.record(z.string(), z.unknown()), locked: z.array(id), cleared: z.array(id) }).strict(),
  "acquisition.start": z.object({ url: z.string().url(), fileName: id, targetDir: z.string().min(1), quotaBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(), previousEtag: z.string().optional(), injectDiskFull: z.boolean().optional() }).strict(),
  "library.find": z.object({
    text: z.string().max(512),
    readAllowlist: z.array(id).max(10000).optional(),
    resourceId: id.optional(),
    withinProgress: z.boolean().optional(),
  }).strict(),
  "notes.undo": z.object({ objectId: id, expectedRevision: z.number().int().positive() }).strict(),
  "inventory.overview": z.object({}).strict(),
  "inventory.scan": z.object({}).strict(),
  "inventory.cancelScan": z.object({ scanId: id.optional() }).strict(),
  "inventory.reveal": z.object({ id: id }).strict(),
  "inventory.repair": z.object({ id: id, pathHandle: id.optional() }).strict(),
  "settings.get": z.object({}).strict(),
  "settings.skipAi": z.object({}).strict(),
  "settings.proposeLocations": z.object({
    pathHandle: id.optional(),
    partitions: z.partialRecord(z.enum(LOCATION_PARTITIONS), id).optional(),
    indexedOnly: z.array(z.enum(LOCATION_PARTITIONS)).max(LOCATION_PARTITIONS.length).optional(),
  }).strict().refine((value) => Boolean(value.pathHandle || (value.partitions && Object.keys(value.partitions).length)), {
    message: "a root or partition path handle is required",
  }),
  "settings.applyLocations": z.object({
    checkpointId: id,
    pathHandle: id.optional(),
  }).strict(),
  "settings.recoverJobs": z.object({ action: z.enum(["recover", "rollback"]) }).strict(),
  "settings.setRuntime": z.object({ runtime: z.enum(["native", "pi"]) }).strict(),
  "settings.setLayout": z.object({
    pointerPathHandle: id.optional(),
    partitions: z.partialRecord(z.enum(LOCATION_PARTITIONS), id).optional(),
  }).strict(),
  "settings.getShell": z.object({}).strict(),
  "settings.setShell": z.object({
    mode: z.enum(["enthusiast", "creator"]).optional(),
    spoilerGuard: z.boolean().optional(),
    focus: z.boolean().optional(),
    left: ShellPanelSchema.partial().optional(),
    right: ShellPanelSchema.partial().optional(),
    reading: ReadingStylePatchSchema.optional(),
  }).strict(),
  "connections.list": z.object({}).strict(),
  "connections.upsert": z.object({
    id: id.optional(),
    label: id,
    protocol: z.enum(["openai-responses", "openai-chat-completions"]),
    runtime: z.enum(["native", "pi"]).optional(),
    baseUrl: z.string().min(1).max(2048),
    modelId: id,
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    purpose: z.enum(["text", "transcription", "embedding", "vision"]),
    credentialHandle: id.optional(),
  }).strict(),
  "connections.test": z.object({
    connectionId: id,
    capability: z.enum(["text", "tools", "streaming", "transcription", "embedding", "vision"]),
  }).strict(),
  "connections.delete": z.object({ connectionId: id }).strict(),
  "library.transcribeAudio": z.object({
    pathHandle: id,
    connectionId: id.optional(),
  }).strict(),
  "library.indexExternal": z.object({
    pathHandle: id,
    kind: z.enum(["novel", "comic", "video", "audio", "file"]).optional(),
  }).strict(),
  "agent.createSession": z.object({ title: id.optional(), kind: z.enum(["shared", "resource", "project", "work"]).optional(), targetId: id.optional(), mode: z.enum(["enthusiast", "creator"]).optional() }).strict(),
  "agent.send": z.object({
    sessionId: id,
    text: z.string().max(32 * 1024),
    contextSnapshotId: id.optional(),
    readResourceIds: z.array(id).max(10000).optional(),
    noteObjectIds: z.array(id).max(20).optional(),
    selection: z.object({
      resourceId: id,
      resourceRevisionId: id,
      partId: id.optional(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }).strict().optional(),
    mediaContext: AgentMediaContextSchema.optional(),
    /** Recordings whose transcripts are text material, with the time and source each sentence was said at. */
    captureSessionIds: z.array(id).max(3).optional(),
    /** Stills prepared with `material.region` / `material.frame`; at most four. */
    imageMaterialIds: z.array(id).max(4).optional(),
    /** Network commands this task may use. Metadata search reaches an outside service, so it is off unless the user turns it on for the task. */
    allowCommands: z.array(z.enum(["metadata.search"])).max(1).optional(),
    /** Set when the message was made by a quick task: the chat shows the task as a tag and the debug panel names it. The task changes nothing about what the run may use. */
    quickTask: z.object({ id: id.nullable(), name: z.string().min(1).max(80) }).strict().optional(),
  }).strict(),
  "agent.cancel": z.object({ runId: id }).strict(),
  "agent.retry": z.object({ runId: id }).strict(),
  "agent.getRun": z.object({ runId: id }).strict(),
  ...MediaCommandInputs,
  ...ReworkCommandInputs,
};

/**
 * Commands that only the M0 prototype under `experiments/m0` registers. They stay declared so its regression keeps
 * validating; the product does not register them and the registration test excludes them.
 */
export const LEGACY_EXPERIMENT_COMMANDS = ["capture.save", "capture.stat", "capture.preparePlayback", "capture.markPlayback", "metadata.confirm", "metadata.query", "metadata.override", "acquisition.start"] as const;

export function validateCommandInput(commandId: string, input: unknown): unknown {
  const schema = CommandInputs[commandId as keyof typeof CommandInputs];
  if (!schema) throw new Error(`unknown command ${commandId}`);
  return schema.parse(input);
}

/** JSON Schema (draft 2020-12) for a command input, for provider tool definitions. */
export function commandInputJsonSchema(commandId: string): Record<string, unknown> | undefined {
  const schema = CommandInputs[commandId as keyof typeof CommandInputs];
  if (!schema) return undefined;
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}
