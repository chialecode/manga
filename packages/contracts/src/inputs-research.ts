import { z } from "zod";

const id = z.string().min(1).max(256);

/** What a search of the person's own material can return. */
export const RESEARCH_SCOPES = ["work", "note", "recording", "excerpt", "page"] as const;
export type ResearchScope = (typeof RESEARCH_SCOPES)[number];
export const EXCERPT_TEXT_LIMIT = 20_000;

/** Input schemas for searching the local material and for keeping excerpts of web pages (CRE-06). */
export const ResearchCommandInputs = {
  "research.search": z.object({
    text: z.string().trim().min(1).max(512),
    scopes: z.array(z.enum(RESEARCH_SCOPES)).min(1).max(RESEARCH_SCOPES.length).optional(),
    projectId: id.optional(),
    limit: z.number().int().positive().max(100).optional(),
  }).strict(),
  /** Fetches the page at an address the person gave, and keeps its text as a version of that address. */
  "webpage.fetch": z.object({ url: z.string().trim().min(1).max(2048) }).strict(),
  "webpage.list": z.object({ limit: z.number().int().positive().max(500).optional() }).strict(),
  "webpage.get": z.object({ pageId: id }).strict(),
  "webpage.delete": z.object({ pageId: id }).strict(),
  "excerpt.create": z.object({
    pageId: id,
    start: z.number().int().min(0),
    end: z.number().int().min(1),
    title: z.string().trim().max(200).optional(),
    note: z.string().max(2000).optional(),
    projectId: id.optional(),
  }).strict().refine((value) => value.end > value.start, { message: "the excerpt is empty" }),
  "excerpt.list": z.object({ projectId: id.optional(), pageId: id.optional() }).strict(),
  "excerpt.get": z.object({ excerptId: id }).strict(),
  "excerpt.update": z.object({ excerptId: id, title: z.string().trim().max(200).optional(), note: z.string().max(2000).optional() }).strict(),
  "excerpt.delete": z.object({ excerptId: id }).strict(),
  /** Looks for the same passage in the newest version of its page and keeps it there as an excerpt of its own; the old one stays. */
  "excerpt.follow": z.object({ excerptId: id }).strict(),
};
