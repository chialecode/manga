/**
 * Rough cuts (CLIP-01/02): a sequence of clips, each pointing at a revision of a video with the stretch the person asked for. An export copies
 * the streams without re-encoding, so each cut can only start on a keyframe: the plan states what was asked and what will actually be cut.
 */

/** Why a sequence cannot be exported, or why one clip cannot be cut as asked. Each is something the person can act on. */
export const ROUGHCUT_PROBLEMS = [
  "empty", "source-missing", "no-video", "range", "no-keyframe",
  "container", "video-codec", "video-profile", "resolution", "pixel-format", "frame-rate", "time-base", "audio-codec", "audio-format", "audio-tracks",
  /** A chosen track is not in a clip's source; a chosen subtitle track differs in codec from the first clip's; a chosen subtitle track cannot be written to the container as it is. */
  "track-missing", "subtitle-codec", "subtitle-container",
] as const;
export type RoughcutProblemCode = (typeof ROUGHCUT_PROBLEMS)[number];

export type RoughcutProblem = {
  code: RoughcutProblemCode;
  /** The clip the problem is about; absent when it is about the sequence as a whole. */
  clipId?: string;
  /** What differs, in the words of the media tool: `{ first: "h264", other: "hevc" }`. */
  detail?: Record<string, string | number>;
};

/** What the streams of a clip's source say, as far as a copy needs: two clips are joined only if these agree. */
export type RoughcutStreams = {
  container: string;
  /** `parameters` stands for the codec's own setup data (the sequence and picture parameter sets of H.264, the audio specific config of AAC), as a hash. */
  video: { codec: string; profile: string; width: number; height: number; pixelFormat: string; frameRate: string; timeBase: string; parameters: string };
  /** In the order of the file; a track is named by its place in this list. `language` and `title` are the file's own words and are only shown. */
  audio: Array<{ codec: string; sampleRate: number; channels: number; timeBase: string; parameters: string; language: string; title: string }>;
  subtitle: Array<{ codec: string; language: string; title: string }>;
};

/** What an export is asked to be (A-84). Everything is copied as it is: a mode and a choice of tracks never re-encode anything. */
export const ROUGHCUT_MODES = ["merge", "separate"] as const;
export type RoughcutMode = (typeof ROUGHCUT_MODES)[number];

export type RoughcutExportOptions = {
  /** `merge` joins the clips into one file; `separate` writes one file per clip. */
  mode: RoughcutMode;
  /** The audio tracks kept, by their place among the audio tracks of the clips' sources; all of them when absent. An empty list keeps none. */
  audioTracks?: number[];
  /** The subtitle tracks kept, by their place among the subtitle tracks; none when absent (as before). */
  subtitleTracks?: number[];
  /** Write one chapter for each clip into a merged file. Has no effect on a single clip or on separate files. */
  chapters?: boolean;
};

export const DEFAULT_ROUGHCUT_OPTIONS: RoughcutExportOptions = { mode: "merge" };

export type RoughcutClipPlan = {
  clipId: string;
  resourceId: string;
  revisionId: string;
  title: string;
  /** What the person asked for, on the player's timeline in milliseconds. */
  requestedInMs: number;
  requestedOutMs: number;
  /** What a copy gives: it starts at the keyframe at or before the requested start and ends at the first frame at or after the requested end. */
  actualInMs: number;
  actualOutMs: number;
  /** How far the cut moves from what was asked, at each end. */
  startShiftMs: number;
  endShiftMs: number;
  /** The requested start is itself a keyframe, so nothing before it is added. */
  onKeyframe: boolean;
  /** The video frames the copy will hold. */
  frames: number;
  /** The file extension a copy of this clip alone would have (what `separate` writes); null when its container cannot be copied. */
  extension: string | null;
  /** The copy runs to the end of the file. */
  toEnd: boolean;
  /** The gap between the last frame the copy holds and the next, in ms: the tool is told to stop half of it early so a frame on the boundary stays out. */
  frameGapMs: number;
  problems: RoughcutProblem[];
};

export type RoughcutPlan = {
  cutId: string;
  title: string;
  /** What this plan is for: the options as they apply (chapters are dropped where they cannot be written). */
  options: RoughcutExportOptions;
  /** True when every clip can be cut and, for a merged export, the clips can be joined. Nothing is exported otherwise. */
  compatible: boolean;
  /** True when every clip can be exported on its own, whether or not they can be joined: what `separate` needs. */
  separable: boolean;
  /** The tracks of the first clip's source, for choosing among them. */
  tracks: { audio: Array<{ codec: string; channels: number; language: string; title: string }>; subtitle: Array<{ codec: string; language: string; title: string }> };
  problems: RoughcutProblem[];
  clips: RoughcutClipPlan[];
  requestedMs: number;
  actualMs: number;
  /** The container of the finished file (that of the first clip) and its extension; null when the sequence is empty. */
  container: string | null;
  extension: string | null;
  /** What the first clip's source says about its streams; the finished file must agree with it. */
  streams: RoughcutStreams | null;
  tool: string;
};

export const ROUGHCUT_EXPORT_STATES = ["planned", "running", "done", "failed", "cancelled"] as const;
export type RoughcutExportState = (typeof ROUGHCUT_EXPORT_STATES)[number];
export const ROUGHCUT_EXPORT_STEPS = ["cutting", "joining", "checking", "placing"] as const;
export type RoughcutExportStep = (typeof ROUGHCUT_EXPORT_STEPS)[number];

/** What the output was checked against: the duration and frame count the plan promised and what the file holds. */
export type RoughcutOutputCheck = {
  ok: boolean;
  expectedMs: number;
  actualMs: number;
  expectedFrames: number;
  actualFrames: number;
  streamsMatch: boolean;
  /** For a merged file with chapters: the chapters written against the clips. */
  chapters?: { expected: number; actual: number };
};

/** One file an export wrote. */
export type RoughcutExportFile = {
  /** The clip it holds; null for the merged file. */
  clipId: string | null;
  fileName: string;
  bytes: number;
  check: RoughcutOutputCheck;
};

/** One call of the media tool, as the export made it. Places on this machine are replaced by names of what they are. */
export type RoughcutExportCommand = {
  step: "cut" | "join" | "check";
  /** The place of the clip in the sequence, from 1; absent for the join. */
  clip?: number;
  tool: "ffmpeg" | "ffprobe";
  args: string[];
};

export type RoughcutExportView = {
  id: string;
  cutId: string;
  state: RoughcutExportState;
  step: RoughcutExportStep | null;
  /** Clips cut so far, of `total`. */
  done: number;
  total: number;
  plan: RoughcutPlan | null;
  mode: RoughcutMode;
  /** Where the files went: the work's own folder for rough cuts, or a folder the person chose. */
  destination: "work" | "folder";
  /** For the work's folder: its place inside the works folder, as the work page shows it. */
  folder: string | null;
  /** The name of the finished file, never where it is. For separate files, the first one's. */
  fileName: string | null;
  /** Every file written, with what each was checked against. */
  files: RoughcutExportFile[];
  bytes: number | null;
  check: RoughcutOutputCheck | null;
  /** What the media tool was asked, in order. */
  commands: RoughcutExportCommand[];
  /** How long the whole export took, how much of that the media tool did, and the rest (the work of this application). */
  timing: { totalMs: number; toolMs: number; overheadMs: number } | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};
