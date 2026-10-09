import { z } from "zod";
import { PageRegionSchema } from "./media.ts";

const id = z.string().min(1).max(256);
const ms = z.number().int().min(0).max(48 * 60 * 60 * 1000);

/** What the page knew about the moment of a video it captured. */
export const VideoShotSchema = z.object({
  positionMs: ms,
  frame: z.number().int().min(0).max(100_000_000).optional(),
  playbackRate: z.number().min(0.1).max(16).optional(),
  audioTrack: z.string().max(200).optional(),
  subtitleTrack: z.string().max(200).optional(),
  /** The track being shown: the app reads the lines on screen at that moment from it when the page did not. */
  subtitleTrackId: id.optional(),
  subtitleText: z.string().max(2000).optional(),
  /** The secondary track shown under the main one, and its lines at that moment (A-92). */
  subtitleSecondaryTrack: z.string().max(200).optional(),
  subtitleSecondaryText: z.string().max(2000).optional(),
  /** What was drawn into the picture besides the video: the subtitles on screen, the flying comments, both, or nothing. */
  composited: z.enum(["none", "subtitles", "danmaku", "both"]).optional(),
}).strict();

/** What the page knew about the comic page, spread or region it captured. */
export const ComicShotSchema = z.object({
  pageId: id,
  pageLabel: z.string().max(200).optional(),
  pageIndex: z.number().int().min(0).max(1_000_000).optional(),
  spreadPageIds: z.array(id).min(1).max(4).optional(),
  direction: z.enum(["ltr", "rtl", "vertical"]).optional(),
  region: PageRegionSchema.optional(),
}).strict();

/**
 * Input schemas for the files made for works (A-79): screenshots and the folder of a work. The picture comes from the page as base64 PNG at the
 * size of the source; reading them back is also open to a task, within what it was given and what the spoiler guard allows.
 */
export const WorkFileCommandInputs = {
  "screenshot.save": z.object({
    resourceId: id,
    resourceRevisionId: id.optional(),
    data: z.string().min(1).max(80_000_000),
    video: VideoShotSchema.optional(),
    comic: ComicShotSchema.optional(),
  }).strict(),
  "screenshot.list": z.object({ resourceId: id.optional(), workId: id.optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  "screenshot.get": z.object({ screenshotId: id }).strict(),
  /** A picture handle for the screenshot, to show it small. */
  "screenshot.image": z.object({ screenshotId: id }).strict(),
  "screenshot.delete": z.object({ screenshotId: id, deleteFile: z.boolean().optional() }).strict(),
  "workFolders.list": z.object({}).strict(),
  /** The folders that hold what was made for a work or for one resource, and what is in them. Nothing is made until something is written. */
  "workFolders.forWork": z.object({ workId: id.optional(), resourceId: id.optional() }).strict().refine((value) => Boolean(value.workId) !== Boolean(value.resourceId), { message: "name a work or a resource" }),
  "workFolders.rename": z.object({ folderId: id }).strict(),
};
