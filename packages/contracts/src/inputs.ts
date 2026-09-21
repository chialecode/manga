import { z } from "zod";
import { SourceLocatorSchema, TextLocatorSchema } from "./location.ts";
import { LOCATION_PARTITIONS } from "./paths.ts";

const bytes = z.array(z.number().int().min(0).max(255)).min(1).max(16 * 1024 * 1024);
const text = z.string().max(2 * 1024 * 1024);
const id = z.string().min(1).max(256);
export const CommandInputs = {
  "workspace.get": z.object({}).strict(),
  "library.importText": z.object({ title: id, bytes, encoding: z.enum(["utf-8", "utf-16le"]).optional() }).strict(),
  "library.importEpub": z.object({ title: id, bytes }).strict(),
  "library.search": z.object({ text: z.string().max(512), readAllowlist: z.array(id).max(10000).optional() }).strict(),
  "notes.create": z.object({ title: id, text, resourceId: id.optional(), resourceRevisionId: id.optional(), locator: TextLocatorSchema.optional() }).strict(),
  "notes.update": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id.optional(), text }).strict(),
  "capture.save": z.object({ bytes, mimeType: z.enum(["audio/webm", "audio/webm;codecs=opus"]), metadata: z.record(z.string(), z.unknown()) }).strict(),
  "progress.set": z.object({ resourceId: id, resourceRevisionId: id, locator: SourceLocatorSchema }).strict(),
  "library.getResource": z.object({ resourceId: id }).strict(),
  "library.contextSnapshot": z.object({
    resourceId: id,
    resourceRevisionId: id,
    partId: id.optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  }).strict(),
  "library.exportPackage": z.object({ pathHandle: id.optional(), targetDir: z.string().min(1).optional() }).strict(),
  "library.importPackage": z.object({ pathHandle: id.optional(), sourceDir: z.string().min(1).optional() }).strict(),
  "notes.split": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id, offset: z.number().int().nonnegative() }).strict(),
  "notes.merge": z.object({ objectId: id, expectedRevision: z.number().int().positive(), blockId: id }).strict(),
  "notes.embed": z.object({ objectId: id, expectedRevision: z.number().int().positive(), fromBlockId: id, targetId: id, targetKind: z.enum(["object", "anchor"]) }).strict(),
  "capture.stat": z.object({ attachmentId: id }).strict(),
  "capture.preparePlayback": z.object({ attachmentId: id }).strict(),
  "capture.markPlayback": z.object({ attachmentId: id, positionMs: z.number().nonnegative().max(24 * 60 * 60 * 1000) }).strict(),
  "metadata.confirm": z.object({ workId: id, providerId: id, externalId: id }).strict(),
  "reader.ui.present": z.object({}).strict(),
  "reader.resolveAnchor": z.object({ resourceRevisionId: id, locator: TextLocatorSchema }).strict(),
  "metadata.query": z.object({ title: id, mode: z.enum(["single", "fallback", "multi"]), workId: id }).strict(),
  "metadata.override": z.object({ workId: id, fields: z.record(z.string(), z.unknown()), locked: z.array(id), cleared: z.array(id) }).strict(),
  "acquisition.start": z.object({ url: z.string().url(), fileName: id, targetDir: z.string().min(1), quotaBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(), previousEtag: z.string().optional(), injectDiskFull: z.boolean().optional() }).strict(),
  "library.find": z.object({ text: z.string().max(512), readAllowlist: z.array(id).max(10000).optional() }).strict(),
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
  "connections.list": z.object({}).strict(),
  "connections.upsert": z.object({
    id: id.optional(),
    label: id,
    protocol: z.enum(["openai-responses", "openai-chat-completions"]),
    runtime: z.enum(["native", "pi"]).optional(),
    baseUrl: z.string().min(1).max(2048),
    modelId: id,
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    purpose: z.enum(["text", "transcription", "embedding"]),
    credentialHandle: id.optional(),
  }).strict(),
  "connections.test": z.object({
    connectionId: id,
    capability: z.enum(["text", "tools", "streaming", "transcription", "embedding"]),
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
  "agent.createSession": z.object({ title: id.optional() }).strict(),
  "agent.send": z.object({
    sessionId: id,
    text: z.string().max(32 * 1024),
    contextSnapshotId: id.optional(),
    readResourceIds: z.array(id).max(10000).optional(),
  }).strict(),
  "agent.cancel": z.object({ runId: id }).strict(),
  "agent.retry": z.object({ runId: id }).strict(),
  "agent.getRun": z.object({ runId: id }).strict(),
};

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
