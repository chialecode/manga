import type { TranscriptionResult } from "@manga/model-protocol";

export type AsrConnection = {
  id: string;
  model: string;
  timeoutMs: number;
  /** The provider's upload limit, when the connection states one; blocks are cut to fit it. */
  maxUploadBytes?: number;
};

/**
 * The only way recorded audio leaves the machine: one configured transcription connection, one block at a time. No
 * fallback to another service, and nothing here sends audio to a text model.
 */
export interface AsrPort {
  /** The connection a recording would be sent to, or null when none is configured. */
  resolve(connectionId?: string): AsrConnection | null;
  transcribe(connection: AsrConnection, request: {
    fileName: string;
    bytes: Uint8Array;
    mimeType: string;
    prompt?: string;
    language?: string;
    timestamps?: boolean;
    signal: AbortSignal;
  }): Promise<TranscriptionResult>;
}

export type LlmConnection = { id: string };

/** Text-only model used to turn a transcript into a draft note. Audio is never sent through it. */
export interface LlmPort {
  resolve(connectionId?: string): LlmConnection | null;
  complete(connection: LlmConnection, request: { system: string; user: string; signal: AbortSignal }): Promise<string>;
}

export const NO_ASR: AsrPort = {
  resolve: () => null,
  transcribe: () => Promise.reject(new Error("no transcription connection")),
};

export const NO_LLM: LlmPort = {
  resolve: () => null,
  complete: () => Promise.reject(new Error("no text connection")),
};
