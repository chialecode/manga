import { z } from "zod";

const id = z.string().min(1).max(256);
const ms = z.number().int().min(0).max(48 * 60 * 60 * 1000);
const index = z.number().int().min(0).max(100_000);
const label = z.string().max(200);

/** One step of an edit of a rough cut; all steps of a call are one change, and one undo takes all of them back. */
export const RoughcutAction = z.discriminatedUnion("type", [
  /** A clip of a video. Without a revision, the video's latest one. `index` is where it goes; the end when absent. */
  z.object({ type: z.literal("add"), id: id.optional(), resourceId: id, resourceRevisionId: id.optional(), inMs: ms, outMs: ms, label: label.optional(), index: index.optional() }).strict(),
  z.object({ type: z.literal("update"), clipId: id, inMs: ms.optional(), outMs: ms.optional(), label: label.optional() }).strict(),
  z.object({ type: z.literal("move"), clipId: id, index }).strict(),
  z.object({ type: z.literal("remove"), clipId: id }).strict(),
]);
export type RoughcutActionInput = z.infer<typeof RoughcutAction>;

/** What an export is asked to be: one file or one for each clip, which audio and subtitle tracks, chapters. */
export const RoughcutOptions = z.object({
  mode: z.enum(["merge", "separate"]).default("merge"),
  audioTracks: z.array(z.number().int().min(0).max(63)).max(64).optional(),
  subtitleTracks: z.array(z.number().int().min(0).max(63)).max(64).optional(),
  chapters: z.boolean().optional(),
}).strict();

/** Input schemas for the rough-cut commands: the same ones the interface uses. */
export const RoughcutCommandInputs = {
  "roughcut.list": z.object({ projectId: id.optional() }).strict(),
  "roughcut.create": z.object({ projectId: id, title: z.string().trim().min(1).max(200) }).strict(),
  "roughcut.get": z.object({ cutId: id }).strict(),
  "roughcut.rename": z.object({ cutId: id, title: z.string().trim().min(1).max(200) }).strict(),
  "roughcut.delete": z.object({ cutId: id }).strict(),
  "roughcut.edit": z.object({ cutId: id, label: z.string().max(80).optional(), actions: z.array(RoughcutAction).min(1).max(200) }).strict(),
  "roughcut.undo": z.object({ cutId: id }).strict(),
  "roughcut.redo": z.object({ cutId: id }).strict(),
  /** Checks the clips against each other and against the keyframes of their sources, and says what would be cut. Changes nothing. */
  "roughcut.plan": z.object({ cutId: id, options: RoughcutOptions.optional() }).strict(),
  /**
   * Starts the export; the answer comes at once and the progress arrives as notices. Without a folder the files go into the work's own folder for rough cuts;
   * with one, into the folder the person chose.
   */
  "roughcut.export": z.object({ cutId: id, pathHandle: id.optional(), fileName: z.string().trim().min(1).max(120).optional(), options: RoughcutOptions.optional() }).strict(),

  "roughcut.cancel": z.object({ exportId: id }).strict(),
  "roughcut.exports": z.object({ cutId: id }).strict(),
};
