import { z } from "zod";

const id = z.string().min(1).max(256);

export const ASR_ENGINE_KINDS = ["local", "connection"] as const;
export type AsrEngineKind = (typeof ASR_ENGINE_KINDS)[number];

/** Which speech recognizer a feature uses: a downloaded local model or a configured transcription connection. */
export const AsrEngineSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local"), modelId: id }).strict(),
  z.object({ kind: z.literal("connection"), connectionId: id }).strict(),
]);
export type AsrEngineSelection = z.infer<typeof AsrEngineSelectionSchema>;

export const DICTATION_MODES = ["hold", "locked"] as const;
export type DictationMode = (typeof DICTATION_MODES)[number];

export const DICTATION_STAGES = [
  "recording",
  "trimming",
  "recognizing",
  "correcting",
  "polishing",
  "done",
  "no_speech",
  "failed",
  "cancelled",
] as const;
export type DictationStage = (typeof DICTATION_STAGES)[number];

export const DICTATION_INSERT_MODES = ["stream_replace", "final_only"] as const;
export type DictationInsertMode = (typeof DICTATION_INSERT_MODES)[number];

export const DICTATION_STOP_REASONS = ["user", "max_duration", "device_lost"] as const;
export type DictationStopReason = (typeof DICTATION_STOP_REASONS)[number];

export const POLISH_MODES = ["raw", "light", "formal"] as const;
export type PolishMode = (typeof POLISH_MODES)[number];

export const PolishPromptsSchema = z.object({
  light: z.string().max(8000).nullable().optional(),
  formal: z.string().max(8000).nullable().optional(),
}).strict();
export type PolishPrompts = z.infer<typeof PolishPromptsSchema>;

export const CHINESE_VARIANTS = ["simplified", "traditional", "none"] as const;
export type ChineseVariant = (typeof CHINESE_VARIANTS)[number];

export const AUDIO_WARNINGS = ["low_volume", "clipping"] as const;
export type AudioWarning = (typeof AUDIO_WARNINGS)[number];

export const DICTIONARY_CATEGORIES = ["character", "actor", "work", "term", "other"] as const;
export const DictionaryCategorySchema = z.enum(DICTIONARY_CATEGORIES);
export type DictionaryCategory = (typeof DICTIONARY_CATEGORIES)[number];

export const DICTIONARY_ALIAS_KINDS = ["alias", "heard", "kana", "romaji", "english"] as const;
export const DictionaryAliasKindSchema = z.enum(DICTIONARY_ALIAS_KINDS);
export type DictionaryAliasKind = (typeof DICTIONARY_ALIAS_KINDS)[number];

export const DictionaryAliasInputSchema = z.object({
  alias: z.string().trim().min(1).max(128),
  kind: DictionaryAliasKindSchema,
}).strict();
export type DictionaryAliasInput = z.infer<typeof DictionaryAliasInputSchema>;

export const DICTIONARY_SUGGESTION_STATUSES = ["pending", "accepted", "ignored"] as const;
export const DictionarySuggestionStatusSchema = z.enum(DICTIONARY_SUGGESTION_STATUSES);
export type DictionarySuggestionStatus = (typeof DICTIONARY_SUGGESTION_STATUSES)[number];

export type DictationReplacement = {
  start: number;
  end: number;
  original: string;
  replacement: string;
  termId?: string;
  term: string;
  category?: DictionaryCategory;
  score: number;
};

export type DictationTimings = {
  recordMs?: number;
  trimMs?: number;
  denoiseMs?: number;
  recognizeMs?: number;
  correctMs?: number;
  polishMs?: number;
  totalMs?: number;
};

export type DictationSessionSnapshot = {
  dictationId: string;
  mode: DictationMode;
  stage: DictationStage;
  loadingModel?: boolean;
  workId: string | null;
  durationMs: number;
  rawText: string;
  correctedText: string;
  finalText: string;
  polishMode: PolishMode;
  fallbackReason: string | null;
  warnings: AudioWarning[];
  replacements: DictationReplacement[];
  errorMessage?: string | null;
  errorCode?: string | null;
  timings?: DictationTimings;
  historyId?: string | null;
};

export type DictationHistoryItem = {
  id: string;
  workId: string | null;
  engineKind: string;
  engineId: string;
  modelId: string;
  polishMode: PolishMode;
  rawText: string;
  correctedText: string;
  finalText: string;
  fallbackReason: string | null;
  timings: DictationTimings;
  replacements: DictationReplacement[];
  audioAvailable: boolean;
  audioExpiresAt: string | null;
  createdAt: string;
};

export type LocalAsrModelSource = {
  id: string;
  label: string;
  url: string;
};

export type LocalAsrModelState =
  | "not_installed"
  | "downloading"
  | "paused"
  | "verifying"
  | "installed"
  | "loading"
  | "ready"
  | "load_failed"
  | "failed";

export type LocalAsrModelItem = {
  modelId: string;
  name: string;
  kind: string;
  languages: string[];
  hotwords: number;
  recommended?: boolean;
  license: string;
  licenseUrl: string;
  archiveName: string;
  archiveBytes: number;
  archiveSha256: string;
  sources: LocalAsrModelSource[];
  state: LocalAsrModelState;
  downloadedBytes?: number;
  totalBytes?: number;
  installedBytes?: number;
  errorMessage?: string | null;
};

export type DictionarySuggestionItem = {
  id: string;
  scope: "global" | "work";
  workId: string | null;
  term: string;
  heard: string;
  score: number;
  status: DictionarySuggestionStatus;
  createdAt: string;
  updatedAt: string;
};
