import { z } from "zod";

const id = z.string().min(1).max(256);
const jobId = z.string().min(1).max(128);

/** Seeding is opt-in and bounded: until a ratio of upload to the torrent's size is reached, at a speed no higher than the limit; 0 is no limit. */
const budget = z.object({
  maxBytes: z.number().int().positive().max(2 ** 50).optional(),
  downKbps: z.number().int().min(0).max(10_000_000).optional(),
  upKbps: z.number().int().min(0).max(10_000_000).optional(),
}).strict();

/** Input schemas for the acquisition commands: the same ones the interface and an agent with the permission use. */
export const AcquisitionCommandInputs = {
  /** Whether an engine is ready, and every job. */
  "acquisition.list": z.object({}).strict(),
  "acquisition.get": z.object({ jobId }).strict(),
  /** Starts a job from a magnet link or a torrent file the person chose. `pathId` is the library path the files are published into, and `subdir` a folder under it. */
  "acquisition.add": z.object({
    magnet: z.string().min(8).max(8192).optional(),
    pathHandle: id.optional(),
    pathId: id,
    subdir: z.string().max(200).optional(),
    budget: budget.optional(),
  }).strict().refine((value) => Number(Boolean(value.magnet)) + Number(Boolean(value.pathHandle)) === 1, { message: "give a magnet link or a torrent file, not both and not neither" }),
  /** The files of the torrent the person wants (by their number in the list the job reported). */
  "acquisition.select": z.object({ jobId, indexes: z.array(z.number().int().min(0)).min(1).max(100_000), budget: budget.optional() }).strict(),
  "acquisition.pause": z.object({ jobId }).strict(),
  "acquisition.resume": z.object({ jobId }).strict(),
  /** Stops the job and deletes what it had downloaded and not yet published; what was published and imported stays. */
  "acquisition.cancel": z.object({ jobId }).strict(),
  /** Forgets a job that ended. Published files and what they became are not touched. */
  "acquisition.remove": z.object({ jobId }).strict(),
  "acquisition.retryPublish": z.object({ jobId }).strict(),
  "acquisition.retryImport": z.object({ jobId }).strict(),
  /** Starts a job over when what it left cannot be continued by the engine that is installed now. */
  "acquisition.restart": z.object({ jobId }).strict(),
  "acquisition.setSeeding": z.object({ jobId, enabled: z.boolean(), ratio: z.number().min(0).max(100).optional(), upKbps: z.number().int().min(0).max(10_000_000).optional() }).strict(),
};
