export { convertChineseVariant } from "./opencc.ts";

export {
  DictationPolisher,
  type PolishInput,
  type PolishLlmClient,
  type PolishLlmConnection,
  type PolishLlmRequest,
  type PolishResult,
} from "./polisher.ts";

export {
  DEFAULT_FORMAL_POLISH_PROMPT,
  DEFAULT_LIGHT_POLISH_PROMPT,
  POLISH_MAX_LENGTH_RATIO,
  POLISH_MIN_LENGTH_RATIO,
  POLISH_TEMPERATURE,
  POLISH_TIMEOUT_MS,
  resolvePolishSystemPrompt,
} from "./prompts.ts";
