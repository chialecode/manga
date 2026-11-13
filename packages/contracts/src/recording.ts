import type {
  AsrEngineSelection,
  ChineseVariant,
  DictationInsertMode,
  PolishMode,
  PolishPrompts,
} from "./dictation.ts";
import { PROMPT_LIMIT_DEFAULT } from "./inputs-creative.ts";

/** Saved floating recording overlay position. */
export type RecordingOverlay = { x?: number; y?: number };

/** Single source of truth for voice capture, dictation, and read-aloud settings shared by app-core and renderer. */
export type RecordingSettings = {
  /** `null` is the system default microphone. */
  deviceId: string | null;
  /** In-app hold-to-record key (a `KeyboardEvent.code`, for example `F9`). Hold is never a global shortcut. */
  holdKey: string;
  toggleKey: string;
  retention: "keep" | "discard";
  duckPlayback: "none" | "lower" | "pause";
  /** Kept on each side of detected speech, so the first and last syllables are not cut. */
  boundaryMarginMs: number;
  overlay: RecordingOverlay;
  /** The language the recording is spoken in, as the provider names it ("zh", "ja", "en"); `null` lets the provider decide. */
  language: string | null;
  /** The longest dictionary hint sent with a block of audio, in characters. A model may take less than this, so a connection can have its own limit. */
  promptChars: number;
  promptCharsByConnection: Record<string, number>;
  echoCancellation: boolean;
  systemLoopbackAec: boolean;
  browserNoiseSuppression: boolean;
  autoGainControl: boolean;
  gtcrnDenoise: boolean;
  dictationHoldKey: string;
  dictationInsertMode: DictationInsertMode;
  polishMode: PolishMode;
  polishPrompts: PolishPrompts;
  polishConnectionId: string | null;
  chineseVariant: ChineseVariant;
  dictationEngine: AsrEngineSelection | null;
  captureEngine: AsrEngineSelection | null;
  localIdleMinutes: number;
  retainDictationAudio24h: boolean;
  /** The speech connection that reads aloud; `null` uses the first one there is. */
  speechConnectionId: string | null;
  /** The voice that reads aloud: `stella` (女声) or `tide` (男声). */
  speechVoice: "stella" | "tide";
  /** Whether reading a novel aloud first says what it may cost. */
  novelCostHint: boolean;
};

/** Patch accepted by `settings.setRecording`: `null` in `promptCharsByConnection` or `overlay` clears back to default. */
export type RecordingSettingsPatch = Partial<Omit<RecordingSettings, "overlay" | "promptCharsByConnection" | "polishPrompts">> & {
  overlay?: { x?: number | null; y?: number | null };
  promptCharsByConnection?: Record<string, number | null>;
  polishPrompts?: PolishPrompts;
};

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  deviceId: null,
  holdKey: "F9",
  toggleKey: "F8",
  retention: "keep",
  duckPlayback: "lower",
  boundaryMarginMs: 300,
  overlay: {},
  language: null,
  promptChars: PROMPT_LIMIT_DEFAULT,
  promptCharsByConnection: {},
  echoCancellation: true,
  systemLoopbackAec: false,
  browserNoiseSuppression: false,
  autoGainControl: true,
  gtcrnDenoise: false,
  dictationHoldKey: "RightAlt",
  dictationInsertMode: "stream_replace",
  polishMode: "light",
  polishPrompts: {},
  polishConnectionId: null,
  chineseVariant: "simplified",
  dictationEngine: null,
  captureEngine: null,
  localIdleMinutes: 10,
  retainDictationAudio24h: false,
  speechConnectionId: null,
  speechVoice: "stella",
  novelCostHint: true,
};
