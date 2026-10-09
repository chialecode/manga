import { z } from "zod";

const id = z.string().min(1).max(256);

/** What a semantic search can return: a passage of a book, a note, a recorded sentence, an excerpt. */
export const SEMANTIC_KINDS = ["body", "note", "recording", "excerpt"] as const;
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];
/** The ways the text can be cut into pieces that each get a vector (the number is the longest piece, in characters). */
export const SEMANTIC_SEGMENTATIONS = ["paragraph-300", "paragraph-600", "paragraph-1200"] as const;
export type SemanticSegmentation = (typeof SEMANTIC_SEGMENTATIONS)[number];

/** Input schemas for the optional semantic index and the search that uses it (SEARCH-02). */
export const SemanticCommandInputs = {
  "semantic.status": z.object({}).strict(),
  /** Turns the index on or off, and picks the embedding connection and the way of cutting. A change that needs a different index builds a new version. */
  "semantic.configure": z.object({
    enabled: z.boolean(),
    connectionId: id.optional(),
    segmentation: z.enum(SEMANTIC_SEGMENTATIONS).optional(),
  }).strict(),
  /** Builds a new version from the current settings, even when nothing changed. The version being used keeps answering until the new one is complete. */
  "semantic.rebuild": z.object({}).strict(),
  "semantic.cancel": z.object({}).strict(),
  /** Adds what was written since the index was made, and drops what is gone. */
  "semantic.update": z.object({}).strict(),
  /** Deletes every version and its vectors. The content they were made from is not touched. */
  "semantic.clear": z.object({}).strict(),
  "semantic.search": z.object({
    text: z.string().trim().min(1).max(1000),
    limit: z.number().int().positive().max(50).optional(),
    kinds: z.array(z.enum(SEMANTIC_KINDS)).min(1).max(SEMANTIC_KINDS.length).optional(),
    projectId: id.optional(),
    resourceId: id.optional(),
    /** Only passages of books the person has already read. */
    withinProgress: z.boolean().optional(),
  }).strict(),
};
