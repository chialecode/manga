import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Sidecar = { id: string; fileName: string; absolutePath: string; format: "ass" | "srt" | "vtt"; language?: string };

const SUBTITLE_EXTENSIONS: Record<string, Sidecar["format"]> = { ".ass": "ass", ".ssa": "ass", ".srt": "srt", ".vtt": "vtt" };
const SUBTITLE_FOLDERS = new Set(["subs", "subtitles", "subtitle", "sub"]);

/** `zh-CN`, `en`, `chs`, `jpn` and the like. A suffix that is just a release tag ("forced", "default") is not a language. */
function languageOf(suffix: string): string | undefined {
  const cleaned = suffix.replace(/^[.\-_ ]+|[.\-_ ]+$/g, "");
  if (!cleaned || /^(forced|default|sdh|cc)$/i.test(cleaned)) return undefined;
  return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,4})?$|^(chs|cht|sc|tc|jpsc|jptc)$/i.test(cleaned) ? cleaned.replace("_", "-") : cleaned.slice(0, 24);
}

/**
 * Subtitle files that belong to a video: same folder (or a Subs folder next to it), named like the video with an optional
 * language suffix. A file named for another episode is not a sidecar.
 */
export function discoverSidecars(videoFile: string): Sidecar[] {
  const dir = path.dirname(videoFile);
  const stem = path.basename(videoFile, path.extname(videoFile));
  const lowerStem = stem.toLowerCase();
  const found: Sidecar[] = [];
  const scan = (folder: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const format = SUBTITLE_EXTENSIONS[ext];
      if (!format) continue;
      const base = entry.name.slice(0, entry.name.length - ext.length);
      const lower = base.toLowerCase();
      if (lower !== lowerStem && !(lower.startsWith(lowerStem) && /^[.\-_ ]/.test(base.slice(stem.length)))) continue;
      const absolutePath = path.join(folder, entry.name);
      found.push({
        id: `x${createHash("sha1").update(entry.name).digest("hex").slice(0, 10)}`,
        fileName: entry.name,
        absolutePath,
        format,
        ...(languageOf(base.slice(stem.length)) ? { language: languageOf(base.slice(stem.length)) } : {}),
      });
    }
  };
  scan(dir);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SUBTITLE_FOLDERS.has(entry.name.toLowerCase())) scan(path.join(dir, entry.name));
    }
  } catch { /* the folder vanished; there are simply no sidecars */ }
  return found.sort((a, b) => a.fileName.localeCompare(b.fileName, "zh-CN", { numeric: true }));
}

/** Identity of a video that does not need every byte: the size plus three 4 MiB windows. Re-encoded or edited files differ. */
export async function sampledFingerprint(file: string, signal?: AbortSignal): Promise<string> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const window = 4 * 1024 * 1024;
    const hash = createHash("sha256").update(`v1|${size}|`);
    const offsets = size <= window * 3 ? [0] : [0, Math.floor((size - window) / 2), size - window];
    for (const offset of offsets) {
      signal?.throwIfAborted();
      const length = offsets.length === 1 ? size : window;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `sv1:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}
