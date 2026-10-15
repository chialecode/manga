import { z } from "zod";

const id = z.string().min(1).max(256);

/** Where the comments come from, shown wherever danmaku is shown (Q-28). */
export const DANMAKU_ATTRIBUTION = "弹幕来自弹弹play开放弹幕网络";

/** The three kinds of comment the display knows; the network's own modes 1, 4 and 5 map onto them. */
export const DANMAKU_MODES = ["scroll", "bottom", "top"] as const;
export type DanmakuMode = (typeof DANMAKU_MODES)[number];

/** How much of the picture's height the scrolling comments may use. */
export const DANMAKU_AREAS = [0.25, 0.5, 0.75, 1] as const;

export const DanmakuSettingsSchema = z.object({
  /** Whether danmaku is shown while watching. Off until the person turns it on; nothing is requested while it is off. */
  enabled: z.boolean(),
  opacity: z.number().min(0.1).max(1),
  /** Percent of the base size. */
  size: z.number().int().min(50).max(200),
  /** Pixels per second for scrolling comments across a picture 1920 wide; the display scales it with the width, so a comment takes 1920 / speed seconds to cross at any size. */
  speed: z.number().int().min(60).max(400),
  /** Whether the comments' speed on the screen follows the playback rate (on: twice as fast at 2x, as before) or stays what `speed` says whatever the rate is (off). */
  followRate: z.boolean(),
  area: z.number().refine((value) => (DANMAKU_AREAS as readonly number[]).includes(value), "area must be 0.25, 0.5, 0.75 or 1"),
  scroll: z.boolean(),
  top: z.boolean(),
  bottom: z.boolean(),
  color: z.boolean(),
  merge: z.boolean(),
  blockWords: z.array(z.string().min(1).max(64)).max(200),
  blockPatterns: z.array(z.string().min(1).max(200)).max(50),
  /** Sources the person turned off, by the prefix the network puts before a sender (the network's own comments have the empty prefix). */
  sourcesOff: z.array(z.string().max(64)).max(64),
  /** What the network does to the text before sending: nothing, simplified Chinese, or traditional Chinese. */
  convert: z.enum(["none", "simplified", "traditional"]),
  /** Whether a screenshot of the picture keeps the comments that are on it. */
  shotWith: z.boolean(),
}).strict();
export type DanmakuSettings = z.infer<typeof DanmakuSettingsSchema>;

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  enabled: false,
  opacity: 0.8,
  size: 100,
  speed: 192,
  followRate: true,
  area: 0.5,
  scroll: true,
  top: true,
  bottom: false,
  color: true,
  merge: true,
  blockWords: [],
  blockPatterns: [],
  sourcesOff: [],
  convert: "simplified",
  shotWith: false,
};

/**
 * A pattern the person typed is kept only when the engine can build it and it cannot make the screen wait: a group that holds a repeat and is repeated
 * itself, like `(a+)+`, is the classic way to make a match take forever, and is refused.
 */
export function validPattern(pattern: string): boolean {
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) return false;
  try { new RegExp(pattern, "u"); return true; } catch { return false; }
}

export const DanmakuSettingsPatchSchema = DanmakuSettingsSchema.partial().strict().superRefine((value, ctx) => {
  (value.blockPatterns ?? []).forEach((pattern, index) => {
    if (!validPattern(pattern)) ctx.addIssue({ code: "custom", path: ["blockPatterns", index], message: "not a valid regular expression, or one that could take too long" });
  });
});
export type DanmakuSettingsPatch = z.infer<typeof DanmakuSettingsPatchSchema>;

/** One comment as the display receives it: milliseconds from the start of the episode, before the person's offset. */
export type DanmakuItem = { at: number; mode: DanmakuMode; color: number; source: string; text: string };

/** The kinds of "cannot" the display explains instead of showing nothing. */
export const DANMAKU_FAILURES = ["no_credentials", "forbidden", "rate_limited", "network", "bad_response", "no_match", "needs_consent", "needs_choice", "offline_cache_only"] as const;
export type DanmakuFailure = (typeof DANMAKU_FAILURES)[number];

export type DanmakuMatchInfo = {
  source: string;
  animeId: number | null;
  episodeId: number;
  animeTitle: string;
  episodeTitle: string;
  offsetMs: number;
  /** How the episode was found: through the Bangumi entry, by file fingerprint and name, by name alone, or picked by the person. */
  method: "bangumi" | "hash" | "name" | "manual";
  confirmed: boolean;
  matchedAt: string;
};

export type DanmakuCandidate = { animeId: number | null; animeTitle: string; episodeId: number; episodeTitle: string; typeDescription?: string };

const revision = id.optional();

/** Input schemas for the danmaku module. The network is reached only by `match`, `search` and `load`, and only for the episode being watched. */
export const DanmakuCommandInputs = {
  /** What is known about the episode without asking the network: credentials, the saved match, the cache, and whether a question to the person is open. */
  "danmaku.status": z.object({ resourceId: id, resourceRevisionId: revision }).strict(),
  /**
   * Find the episode. `consent` records the person's answer for a work that is not linked to an online entry (the file's name, fingerprint, size and
   * length are sent only after a yes); `refresh` looks again even when a match is saved.
   */
  "danmaku.match": z.object({ resourceId: id, resourceRevisionId: revision, consent: z.boolean().optional(), refresh: z.boolean().optional() }).strict(),
  "danmaku.search": z.object({ query: z.string().min(1).max(128), episode: z.number().int().min(0).max(100_000).optional() }).strict(),
  "danmaku.choose": z.object({
    resourceId: id,
    resourceRevisionId: revision,
    episodeId: z.number().int().positive(),
    animeId: z.number().int().positive().nullable().optional(),
    animeTitle: z.string().max(256),
    episodeTitle: z.string().max(256),
  }).strict(),
  "danmaku.setOffset": z.object({ resourceId: id, resourceRevisionId: revision, offsetMs: z.number().int().min(-600_000).max(600_000) }).strict(),
  /** The comments of the matched episode: from the cache while it is fresh, else from the network. `refresh` is allowed once a minute per episode. */
  "danmaku.load": z.object({ resourceId: id, resourceRevisionId: revision, refresh: z.boolean().optional() }).strict(),
  "danmaku.getSettings": z.object({}).strict(),
  "danmaku.setSettings": DanmakuSettingsPatchSchema,
  /** The person's own application credentials replace the built-in ones; a handle comes from `stashSecret`, as for a model connection. */
  "danmaku.setCredentials": z.object({ credentialHandle: id.optional(), clear: z.boolean().optional() }).strict(),
  "danmaku.clearCache": z.object({}).strict(),
  /** For a task: how many comments there are near a moment and a few of them, from the cache only and never later than what has been watched. */
  "danmaku.around": z.object({
    resourceId: id,
    resourceRevisionId: z.string().min(1).max(256),
    centerMs: z.number().int().min(0),
    windowMs: z.number().int().min(1000).max(120_000).optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }).strict(),
};
