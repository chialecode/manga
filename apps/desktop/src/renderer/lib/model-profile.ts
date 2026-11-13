import type { ModelInputType, ModelProfile, ModelProfilePatch, ReasoningEffort, TranscriptionInterface } from "@manga/contracts/models";
import { MODEL_CAPABILITIES, MODEL_INPUT_TYPES, REASONING_EFFORTS } from "@manga/contracts/models";

export { MODEL_CAPABILITIES, MODEL_INPUT_TYPES, REASONING_EFFORTS };

/** The profile as the form holds it: numbers are typed text until they are saved. */
export type ProfileForm = {
  contextWindow: string;
  maxOutput: string;
  inputTypes: string[];
  capabilities: string[];
  /** Empty is "not set". */
  reasoningEffort: string;
  /** What the model takes of a whole PDF and a video clip (计划 4.5): MiB and seconds, typed. */
  fileMiB: string;
  videoMiB: string;
  videoSeconds: string;
  transcriptionInterface: TranscriptionInterface;
};

const MiB = 1024 * 1024;
const mib = (bytes: number) => String(Math.round((bytes / MiB) * 10) / 10);

export const profileForm = (profile: ModelProfile): ProfileForm => ({
  contextWindow: String(profile.contextWindow),
  maxOutput: String(profile.maxOutput),
  inputTypes: [...profile.inputTypes],
  capabilities: [...profile.capabilities],
  reasoningEffort: profile.reasoningEffort ?? "",
  fileMiB: mib(profile.limits.fileBytes),
  videoMiB: mib(profile.limits.videoBytes),
  videoSeconds: String(profile.limits.videoSeconds),
  transcriptionInterface: profile.transcriptionInterface ?? "audio_transcriptions",
});

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);

/** Only what the person changed: a number left as it was keeps where it came from (a default, or what a test found). */
export function profilePatch(before: ProfileForm, after: ProfileForm): ModelProfilePatch {
  const patch: ModelProfilePatch = {};
  const window = Number(after.contextWindow);
  const output = Number(after.maxOutput);
  if (after.contextWindow !== before.contextWindow && Number.isFinite(window)) patch.contextWindow = Math.round(window);
  if (after.maxOutput !== before.maxOutput && Number.isFinite(output)) patch.maxOutput = Math.round(output);
  if (!same(before.inputTypes, after.inputTypes)) patch.inputTypes = after.inputTypes.filter((item): item is ModelInputType => (MODEL_INPUT_TYPES as readonly string[]).includes(item));
  if (!same(before.capabilities, after.capabilities)) patch.capabilities = after.capabilities.filter((item): item is (typeof MODEL_CAPABILITIES)[number] => (MODEL_CAPABILITIES as readonly string[]).includes(item));
  if (before.reasoningEffort !== after.reasoningEffort) patch.reasoningEffort = after.reasoningEffort === "" ? null : (after.reasoningEffort as ReasoningEffort);
  const limits: NonNullable<ModelProfilePatch["limits"]> = {};
  if (after.fileMiB !== before.fileMiB) limits.fileBytes = Math.round(Number(after.fileMiB) * MiB);
  if (after.videoMiB !== before.videoMiB) limits.videoBytes = Math.round(Number(after.videoMiB) * MiB);
  if (after.videoSeconds !== before.videoSeconds) limits.videoSeconds = Math.round(Number(after.videoSeconds));
  if (Object.keys(limits).length) patch.limits = limits;
  if (after.transcriptionInterface !== before.transcriptionInterface) patch.transcriptionInterface = after.transcriptionInterface;
  return patch;
}

/** What the form would save is checked here first, so the person is told before the main process refuses it. */
export function profileProblem(form: ProfileForm): "window" | "output" | "order" | "fileLimit" | "videoLimit" | "videoSeconds" | null {
  const window = Number(form.contextWindow);
  const output = Number(form.maxOutput);
  if (!Number.isInteger(window) || window < 4_096 || window > 10_000_000) return "window";
  if (!Number.isInteger(output) || output < 256 || output > 1_000_000) return "output";
  if (output >= window) return "order";
  // The limits matter only for an input the model takes; the bounds are the schema's (1–50 MiB, 1–20 MiB, 5–600 s).
  const within = (text: string, low: number, high: number) => text.trim() !== "" && Number.isFinite(Number(text)) && Number(text) >= low && Number(text) <= high;
  if (form.inputTypes.includes("pdf") && !within(form.fileMiB, 1, 50)) return "fileLimit";
  if (form.inputTypes.includes("video") && !within(form.videoMiB, 1, 20)) return "videoLimit";
  if (form.inputTypes.includes("video") && (!within(form.videoSeconds, 5, 600) || !Number.isInteger(Number(form.videoSeconds)))) return "videoSeconds";
  return null;
}

/** The short statement of a result's time, as seconds with one decimal. */
export const seconds = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);
