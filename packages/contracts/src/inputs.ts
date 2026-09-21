import { z } from "zod";
import { SourceLocatorSchema, TextLocatorSchema } from "./location.ts";

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
  "library.exportPackage": z.object({ targetDir: z.string().min(1) }).strict(),
  "library.importPackage": z.object({ sourceDir: z.string().min(1) }).strict(),
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
};

export function validateCommandInput(commandId: string, input: unknown): unknown {
  const schema = CommandInputs[commandId as keyof typeof CommandInputs];
  if (!schema) throw new Error(`unknown command ${commandId}`);
  return schema.parse(input);
}
