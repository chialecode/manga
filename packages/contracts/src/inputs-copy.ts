import { z } from "zod";

const id = z.string().min(1).max(256);

/** What a suggestion for a draft can do. Every one of them only proposes: the draft changes when the person takes the suggestion (CRE-05). */
export const DRAFT_SUGGESTION_KINDS = ["outline", "continue", "polish", "translate", "terms", "cite"] as const;
export type DraftSuggestionKind = (typeof DRAFT_SUGGESTION_KINDS)[number];
/** Where a suggestion is: still being written, ready to look at, failed or cancelled, taken, or put aside. */
export const DRAFT_SUGGESTION_STATUSES = ["running", "pending", "failed", "cancelled", "adopted", "discarded"] as const;
export type DraftSuggestionStatus = (typeof DRAFT_SUGGESTION_STATUSES)[number];
/** What a suggestion can be made from besides the draft: other text objects of the person, and the project's term list. */
export const DRAFT_SOURCE_KINDS = ["note", "excerpt", "draft", "mindmap", "whiteboard", "recording", "terms"] as const;
export type DraftSourceKind = (typeof DRAFT_SOURCE_KINDS)[number];

export const DRAFT_TEXT_LIMIT = 200_000;

const DraftSourceRef = z.object({ kind: z.enum(DRAFT_SOURCE_KINDS), targetId: id }).strict();
const Range = z.object({ start: z.number().int().min(0).max(DRAFT_TEXT_LIMIT), end: z.number().int().min(0).max(DRAFT_TEXT_LIMIT) }).strict().refine((value) => value.end >= value.start, { message: "the range ends before it starts" });

/** Input schemas for drafts and the suggestions made for them. */
export const CopyCommandInputs = {
  "draft.list": z.object({ projectId: id.optional() }).strict(),
  "draft.create": z.object({ projectId: id, title: z.string().trim().min(1).max(200), text: z.string().max(DRAFT_TEXT_LIMIT).optional() }).strict(),
  "draft.get": z.object({ draftId: id }).strict(),
  "draft.rename": z.object({ draftId: id, title: z.string().trim().min(1).max(200) }).strict(),
  "draft.delete": z.object({ draftId: id }).strict(),
  /** A save is refused when the draft moved on since `expectedVersion`, so two windows never overwrite each other silently. */
  "draft.save": z.object({ draftId: id, expectedVersion: z.number().int().positive(), text: z.string().max(DRAFT_TEXT_LIMIT) }).strict(),
  "draft.checkpoint": z.object({ draftId: id, label: z.string().trim().max(120).optional() }).strict(),
  "draft.version": z.object({ draftId: id, version: z.number().int().positive() }).strict(),
  "draft.restore": z.object({ draftId: id, version: z.number().int().positive() }).strict(),
  "draft.suggest": z.object({
    draftId: id,
    kind: z.enum(DRAFT_SUGGESTION_KINDS),
    instruction: z.string().max(1000).optional(),
    sources: z.array(DraftSourceRef).max(12).optional(),
    /** Work on this part of the draft only (polish this paragraph); the rest stays as it is. */
    range: Range.optional(),
    language: z.string().trim().max(40).optional(),
    connectionId: id.optional(),
    /** Make this suggestion again from what the sources say now, with the same kind, instruction and sources. */
    redoOf: id.optional(),
    /** The text itself, when the one asking has already written it (an agent does): no second model is asked, and the suggestion waits for the person to take it. */
    text: z.string().trim().min(1).max(DRAFT_TEXT_LIMIT).optional(),
  }).strict(),
  "draft.suggestions": z.object({ draftId: id }).strict(),
  "draft.suggestion": z.object({ suggestionId: id }).strict(),
  "draft.cancelSuggestion": z.object({ suggestionId: id }).strict(),
  /** Without `force` a draft that changed after the suggestion was made is not overwritten. */
  "draft.adopt": z.object({ suggestionId: id, force: z.boolean().optional() }).strict(),
  "draft.undoAdopt": z.object({ suggestionId: id }).strict(),
  "draft.discardSuggestion": z.object({ suggestionId: id }).strict(),
  /** Keep a suggestion whose sources changed as it is, and take the sources as they are now as its basis. */
  "draft.keepSuggestion": z.object({ suggestionId: id }).strict(),
};
