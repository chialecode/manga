import { z } from "zod";
import { ContextIdSchema, MATERIAL_ORIGINS } from "./workspace-state.ts";

const id = z.string().min(1).max(256);
/** What a conversation is about: the general conversation of "最近", or one bound to a resource, a work, a project or a note. */
export const CONVERSATION_KINDS = ["shared", "resource", "work", "project", "note"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
/** The filter the conversation list and "delete all" share, so what is deleted is what the list shows (A-89). `contextId`: a project, null for "最近", left out for all. */
const conversationFilter = {
  contextId: ContextIdSchema.optional(),
  kind: z.enum(CONVERSATION_KINDS).optional(),
  /** Last activity at or after / before these instants. */
  after: z.string().max(40).optional(),
  before: z.string().max(40).optional(),
  /** Matched against the title and the title of what the conversation is about. */
  q: z.string().trim().max(200).optional(),
};

/** What a project can point at. A reference never copies the thing it points at, and deleting the project leaves personal objects where they are (CRE-01). */
export const PROJECT_MATERIAL_KINDS = ["work", "resource", "anchor", "note", "recording", "excerpt", "whiteboard", "mindmap", "draft", "roughcut", "screenshot"] as const;
export type ProjectMaterialKind = (typeof PROJECT_MATERIAL_KINDS)[number];
export const DICTIONARY_SCOPES = ["global", "work"] as const;
/** The longest transcription hint the settings page accepts, in characters. The model's own limit may be lower. */
export const PROMPT_LIMIT_MIN = 50;
export const PROMPT_LIMIT_MAX = 2000;
export const PROMPT_LIMIT_DEFAULT = 600;

/**
 * Input schemas for the creative workspace and its neighbours: projects, the general conversation of a context, and the voice
 * dictionary. The boards, maps, drafts, excerpts, search index, rough cuts, plugins and acquisition add their own groups below.
 */
export const CreativeCommandInputs = {
  "project.list": z.object({ status: z.enum(["active", "archived", "all"]).optional() }).strict(),
  "project.overview": z.object({}).strict(),
  "project.create": z.object({ name: z.string().trim().min(1).max(120), goal: z.string().max(2000).optional() }).strict(),
  "project.get": z.object({ projectId: id }).strict(),
  "project.update": z.object({
    projectId: id,
    name: z.string().trim().min(1).max(120).optional(),
    goal: z.string().max(2000).optional(),
    status: z.enum(["active", "archived"]).optional(),
    /** The text connection this project's conversations use instead of the default; null returns to the default. */
    modelConnectionId: id.nullable().optional(),
  }).strict(),
  "project.delete": z.object({ projectId: id }).strict(),
  /** `origin` is "auto" when the thing was added because it was opened or made inside the project (Q-33); a thing the person removed is not added that way again. */
  "project.addMaterial": z.object({ projectId: id, kind: z.enum(PROJECT_MATERIAL_KINDS), targetId: id, label: z.string().max(200).optional(), origin: z.enum(MATERIAL_ORIGINS).optional() }).strict(),
  "project.objects": z.object({ projectId: id }).strict(),
  "project.removeMaterial": z.object({ projectId: id, materialId: id }).strict(),
  "project.terms": z.object({ projectId: id }).strict(),
  "project.addTerm": z.object({ projectId: id, term: z.string().trim().min(1).max(128), heard: z.string().max(128).optional(), note: z.string().max(500).optional() }).strict(),
  "project.updateTerm": z.object({ projectId: id, termId: id, term: z.string().trim().min(1).max(128).optional(), heard: z.string().max(128).nullable().optional(), note: z.string().max(500).nullable().optional() }).strict(),
  "project.removeTerm": z.object({ projectId: id, termId: id }).strict(),
  "project.importTerms": z.object({ projectId: id, workId: id }).strict(),
  /** Writes the project and what it owns into one zip in a folder the user picked; only the file name comes back. */
  "project.exportPackage": z.object({ projectId: id, pathHandle: id }).strict(),
  /** Reads a package without changing anything: what it holds, whether it would make a copy, and which references lead to material this profile does not have. */
  "project.packagePreview": z.object({ pathHandle: id }).strict(),
  "project.importPackage": z.object({ pathHandle: id }).strict(),

  /** The current general conversation of a context: "最近" has a shared one, a project has its current project conversation. */
  "conversation.current": z.object({ contextId: ContextIdSchema }).strict(),
  "conversation.new": z.object({ contextId: ContextIdSchema }).strict(),
  "conversation.history": z.object({ contextId: ContextIdSchema, limit: z.number().int().positive().max(100).optional() }).strict(),
  "conversation.resume": z.object({ sessionId: id }).strict(),
  /** A new name for a conversation (the sidebar). */
  "conversation.rename": z.object({ sessionId: id, title: z.string().min(1).max(200) }).strict(),
  /** Moves a general conversation to a project, or to "最近" (`contextId` null). A conversation bound to a resource, work or note is not moved. */
  "conversation.move": z.object({ sessionId: id, contextId: ContextIdSchema }).strict(),
  /** Every conversation of every kind, for the records tab ("对话管理", A-89). Owner only. */
  "conversation.list": z.object({ ...conversationFilter, limit: z.number().int().positive().max(100).optional(), offset: z.number().int().nonnegative().optional() }).strict(),
  /** Deletes the conversations named, with what belongs to them. A conversation with a task in progress is not deleted. */
  "conversation.delete": z.object({ sessionIds: z.array(id).min(1).max(500) }).strict(),
  /** Deletes every conversation the filter matches; without a filter, all of them. */
  "conversation.deleteAll": z.object(conversationFilter).strict(),

  "dictionary.list": z.object({ scope: z.enum(DICTIONARY_SCOPES).optional(), workId: id.optional() }).strict(),
  /** Works whose entry was deleted and that still have terms (A-87). */
  "dictionary.removedWorks": z.object({}).strict(),
  "dictionary.add": z.object({ scope: z.enum(DICTIONARY_SCOPES), workId: id.optional(), term: z.string().trim().min(1).max(128), heard: z.string().max(128).optional() }).strict()
    .refine((value) => (value.scope === "work") === Boolean(value.workId), { message: "a work term needs a work, a global term has none" }),
  "dictionary.update": z.object({ termId: id, term: z.string().trim().min(1).max(128).optional(), heard: z.string().max(128).nullable().optional() }).strict(),
  "dictionary.remove": z.object({ termId: id }).strict(),
  "dictionary.importMetadata": z.object({ workId: id }).strict(),
  "dictionary.prompt": z.object({ workId: id.optional() }).strict(),
};
