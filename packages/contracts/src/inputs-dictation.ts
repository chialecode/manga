import { z } from "zod";
import {
  AsrEngineSelectionSchema,
  DICTATION_MODES,
  DICTATION_STOP_REASONS,
  DictionaryCategorySchema,
  DictionarySuggestionStatusSchema,
} from "./dictation.ts";
import { DICTIONARY_SCOPES } from "./inputs-creative.ts";
import { ContextIdSchema } from "./workspace-state.ts";

const id = z.string().min(1).max(256);

/** Owner-only command inputs for in-app voice dictation, local ASR model management, and dictionary learning. */
export const DictationCommandInputs = {
  "dictation.start": z.object({
    mode: z.enum(DICTATION_MODES),
    workId: id.nullable().optional(),
    contextId: ContextIdSchema.optional(),
    sampleRate: z.literal(16_000).optional(),
  }).strict(),
  "dictation.append": z.object({
    dictationId: id,
    seq: z.number().int().nonnegative().max(10_000_000),
    /** 16-bit little-endian PCM, base64. */
    data: z.string().min(1).max(1_400_000),
  }).strict(),
  "dictation.stop": z.object({
    dictationId: id,
    reason: z.enum(DICTATION_STOP_REASONS).optional(),
  }).strict(),
  "dictation.cancel": z.object({
    dictationId: id.optional(),
  }).strict(),
  "dictation.status": z.object({
    dictationId: id.optional(),
  }).strict(),
  "dictation.history.list": z.object({
    workId: id.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).strict(),
  "dictation.history.delete": z.object({
    historyId: id,
  }).strict(),
  "dictation.history.clear": z.object({}).strict(),
  "dictation.history.retranscribe": z.object({
    historyId: id,
    engine: AsrEngineSelectionSchema,
  }).strict(),

  "asrModel.list": z.object({}).strict(),
  "asrModel.download": z.object({
    modelId: id,
    confirmed: z.literal(true),
    sourceId: z.string().min(1).max(64).optional(),
  }).strict(),
  "asrModel.pause": z.object({
    modelId: id,
  }).strict(),
  "asrModel.cancel": z.object({
    modelId: id,
  }).strict(),
  "asrModel.import": z.object({
    modelId: id,
    pathHandle: id,
    kind: z.enum(["archive", "directory"]),
  }).strict(),
  "asrModel.delete": z.object({
    modelId: id,
  }).strict(),

  "dictionary.importBatch": z.object({
    scope: z.enum(DICTIONARY_SCOPES),
    workId: id.optional(),
    text: z.string().min(1).max(200_000),
    category: DictionaryCategorySchema.optional(),
  }).strict().refine((value) => (value.scope === "work") === Boolean(value.workId), {
    message: "a work term needs a work, a global term has none",
  }),
  "dictionary.cancelImportMetadata": z.object({
    workId: id,
  }).strict(),
  "dictionary.observeEdit": z.object({
    workId: id.nullable().optional(),
    insertedText: z.string().max(20_000),
    editedText: z.string().max(20_000),
  }).strict(),
  "dictionary.suggestions.list": z.object({
    workId: id.optional(),
    status: DictionarySuggestionStatusSchema.optional(),
  }).strict(),
  "dictionary.suggestions.decide": z.object({
    suggestionId: id,
    action: z.enum(["accept", "ignore"]),
  }).strict(),
} as const;
