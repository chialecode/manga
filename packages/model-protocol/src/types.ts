import type {
  AgentCitation,
  AgentErrorCode,
  AgentSearchStep,
  AgentServerToolStep,
  AgentStopReason,
  FileUploadPurpose,
  OcrPurpose,
  OcrResult,
  ProviderBalanceInfo,
  ProviderFileRef,
  SpeechVoice,
  WebFetchResult,
  WebSearchItem,
} from "@manga/contracts";

export type {
  AgentCitation,
  AgentErrorCode,
  AgentSearchStep,
  AgentServerToolStep,
  AgentStopReason,
  FileUploadPurpose,
  OcrPurpose,
  OcrResult,
  ProviderBalanceInfo,
  ProviderFileRef,
  SpeechVoice,
  WebFetchResult,
  WebSearchItem,
};

export type RequestSignal = {
  signal: AbortSignal;
  clear: () => void;
  isTimedOut: () => boolean;
};

/** Token and server-side tool usage counts returned by a model provider. */
export type StreamUsage = {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  searches?: number;
  fetches?: number;
  imageSearches?: number;
};

/** Raw server-side tool event emitted during streaming (aligned with `@manga/contracts` `AgentSearchStep`). */
export type ServerToolEvent = AgentSearchStep;

/** Web page metadata returned by standalone or server-side search. */
export type WebSource = WebSearchItem;

/** Source citation attached to an assistant answer (aligned with `@manga/contracts` `AgentCitation`). */
export type Citation = AgentCitation;

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "title-delta"; text: string }
  | { type: "step-reasoning-done" }
  | { type: "server-tool"; event: ServerToolEvent; steps?: AgentServerToolStep[] }
  | { type: "tool-call-delta"; callId: string; name: string; argumentsDelta: string }
  | {
      type: "completed";
      finishReason: string;
      stopReason?: AgentStopReason;
      refusal?: boolean;
      title?: string;
      usage?: StreamUsage;
      serverToolCalls?: unknown[];
      serverToolSteps?: AgentServerToolStep[];
      citations?: Citation[];
    }
  | {
      type: "error";
      code: string;
      errorCode?: AgentErrorCode;
      message: string;
      retryable: boolean;
      expiredFileIds?: string[];
    };

/** Still image attachment sent to a multimodal chat model. */
export type ImagePart = { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string };

/** Document file attachment (inline PDF base64 for standard OpenAI-compatible servers, or `fileId` for DeepSeek Files API). */
export type FilePart = {
  mediaType: "application/pdf";
  filename: string;
  base64: string;
  /** For budget estimation only; not sent on the wire. */
  pages: number;
  /** Optional provider Files API identifier used instead of inline base64 when present on DeepSeek dialect. */
  fileId?: string;
};

/** Short video clip sent over Chat Completions (`video_url`). */
export type VideoPart = {
  mediaType: "video/mp4";
  base64: string;
  /** For budget estimation only; not sent on the wire. */
  seconds: number;
};

/** Uploaded file reference attached to a user message (DeepSeek flat `{ type: "file", file_id }`). */
export type MessageFileRef = {
  fileId: string;
  filename?: string;
  mimeType?: string;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool" | "latest_reminder";
  content: string;
  /** Attached to user messages only. */
  images?: ImagePart[];
  /** Attached to user messages only. */
  files?: FilePart[];
  /** Attached to user messages only: provider Files API references (e.g. DeepSeek `file-api-...`). */
  fileRefs?: MessageFileRef[];
  /** Attached to user messages only; the Responses protocol never carries them. */
  videos?: VideoPart[];
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /**
   * Thinking text before this assistant message (`reasoning_content`). Sent back within the current turn during tool loops
   * or continuation prefill; omitted for earlier turns.
   */
  reasoning?: string;
  /** Server-side tool call payload returned on an assistant message; round-tripped unchanged for DeepSeek. */
  serverToolCalls?: unknown[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type TextRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Maximum output tokens; omitted lets the provider decide. */
  maxOutputTokens?: number;
  /** Chat Completions token limit field name. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Reasoning effort level; omitted disables thinking on DeepSeek dialect. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "max";
  /** Provider-specific protocol dialect (`deepseek`). */
  dialect?: "deepseek";
  /** Offer DeepSeek built-in web search (`deepseek_web_search`). */
  nativeWebSearch?: boolean;
  /** Offer DeepSeek built-in URL reader (`deepseek_read_url`). */
  readUrl?: boolean;
  /** Ask DeepSeek to return an inline generated conversation title (`title: { enabled: true }`). */
  inlineTitle?: boolean;
  /** Local date/platform/language reminder injected before the active user message (`role: "latest_reminder"`). */
  latestReminder?: string;
  /** Preserve a trailing assistant message to continue an interrupted or `max_tokens` reply. */
  continuePrefill?: boolean;
  /** Enable DeepSeek server-side input/output content safety review (`safety_check: { level: "high" }`). */
  safetyCheck?: "high";
  /** Optional output format constraint (e.g. `{ type: "json_object" }`). */
  responseFormat?: { type: "text" | "json_object" };
  /** Sampling temperature when thinking is disabled. */
  temperature?: number;
  /** Context window size for runtimes that require it. */
  contextWindow?: number;
  /** Optional fetch implementation override for testing. */
  fetchImpl?: typeof fetch;
};

export type CompletedText = {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  reasoning?: string;
  title?: string;
  stopReason?: AgentStopReason;
  refusal?: boolean;
  serverToolCalls?: unknown[];
  serverToolSteps?: AgentServerToolStep[];
  citations?: Citation[];
  usage?: StreamUsage;
};

export type TranscriptionRequest = {
  model: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
  prompt?: string;
  language?: string;
  timestamps?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type TranscriptionSegment = { start: number; end: number; text: string };
export type TranscriptionResult = { text: string; segments?: TranscriptionSegment[]; duration?: number; language?: string };

export type DeepSeekCommonOptions = {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type DeepSeekFileUploadOptions = DeepSeekCommonOptions & {
  filename: string;
  mimeType?: string;
  data: Uint8Array;
  /** Explicit upload purpose; omit to infer from filename/mimeType (omitted for images), or pass `null` to omit explicitly. */
  purpose?: FileUploadPurpose | null;
};

export type DeepSeekFileDeleteOptions = DeepSeekCommonOptions & {
  fileId: string;
};

export type DeepSeekSearchOptions = DeepSeekCommonOptions & {
  query: string;
  count?: number;
  needContent?: boolean;
  oriQuestion?: string;
  localization?: string;
};

export type DeepSeekFetchOptions = DeepSeekCommonOptions & {
  url: string;
};

export type DeepSeekOcrOptions = DeepSeekCommonOptions & {
  filename: string;
  mimeType?: string;
  data: Uint8Array;
  purpose: OcrPurpose;
};

export type DeepSeekBalanceOptions = DeepSeekCommonOptions;

export type DeepSeekBalanceResult = {
  isAvailable: boolean;
  available: boolean;
  checkedAt: string;
  balances: ProviderBalanceInfo[];
};

export type DeepSeekTtsWsOptions = {
  baseUrl: string;
  apiKey: string;
  voice?: SpeechVoice;
  format?: "pcm" | "opus";
  filterMarkdown?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onChunk?: (pcm: Uint8Array) => void;
};

export type DeepSeekTtsWsResult = {
  bytes: number;
  billedChars: number;
  firstChunkMs: number | null;
  transport: "ws";
};

export type DeepSeekTtsWsSession = {
  /** Enqueues a text chunk for incremental synthesis (buffered until the WebSocket opens). */
  push(textChunk: string): void;
  /** Signals no further text will be sent and resolves once all audio frames and server finish confirmation arrive. */
  finish(): Promise<DeepSeekTtsWsResult>;
  /** Cancels the stream immediately and closes the socket. */
  abort(): void;
  /** Resolves with final synthesis metrics when the stream completes. */
  readonly done: Promise<DeepSeekTtsWsResult>;
  /** Async iterator yielding aligned 24 kHz 16-bit mono PCM chunks as they arrive. */
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
};
