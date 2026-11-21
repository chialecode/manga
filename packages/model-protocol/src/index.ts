export { normalizeBaseUrl, rejectCredentialUrl, joinApiPath, createRequestSignal, abortableSleep, mapHttpError, networkError, protocolError, requireMachineAnswer, parseJsonAnswer, type RequestSignal, type StreamEvent, type TextRequest, type ChatMessage, type ImagePart, type FilePart, type VideoPart, type ToolDefinition, type StreamUsage, type ServerToolEvent, type WebSource, type Citation, type TranscriptionRequest, type TranscriptionResult, type TranscriptionSegment } from "./http.ts";
export { completeChatCompletions, completeResponses, streamChatCompletions, streamResponses, deepseekEffort, serverToolEventOf, citationsOf, type CompletedText } from "./openai-http.ts";
export { transcribeAudio, transcribeChatAudio, DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT, type ChatAudioTranscriptionRequest } from "./transcription.ts";
export { completeText, streamText, type AiRuntimeId } from "./pi-ai.ts";
export { startMockProvider, type CapturedChatAudioRequest, type MockProviderOptions } from "./mock-server.ts";
export { syntheticWav } from "./wav.ts";
export { startMockDeepSeek, MOCK_DEEPSEEK_MODELS, MISSING_REASONING_MESSAGE, type MockDeepSeekOptions, type MockDeepSeekRequest } from "./mock-deepseek.ts";
export { transcribeDeepSeek, synthesizeDeepSeek, searchDeepSeek, speechBilledChars, withRetries, retryableStatus, DEEPSEEK_TTS_LIMITS, type WebSearchResult } from "./deepseek-services.ts";
