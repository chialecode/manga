export { normalizeBaseUrl, rejectCredentialUrl, joinApiPath, mapHttpError, type StreamEvent, type TextRequest, type ChatMessage, type ImagePart, type ToolDefinition, type TranscriptionRequest, type TranscriptionResult, type TranscriptionSegment } from "./http.ts";
export { completeChatCompletions, completeResponses, streamChatCompletions, streamResponses } from "./openai-http.ts";
export { transcribeAudio } from "./transcription.ts";
export { completeText, streamText, type AiRuntimeId } from "./pi-ai.ts";
export { startMockProvider } from "./mock-server.ts";
export { syntheticWav } from "./wav.ts";
