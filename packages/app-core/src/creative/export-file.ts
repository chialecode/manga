import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A name that is safe on every file system: no separators or control characters, no reserved device names, not empty, not endless. */
export function safeFileName(title: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 80);
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) return fallback;
  return cleaned;
}

/**
 * Writes an export into a folder the user picked: a temporary file first, renamed into place when complete, and a numbered name when the file
 * already exists, so a finished export never overwrites another file and a failed one leaves nothing half-written. Only the file name is
 * returned; where it is on this machine is the user's own business.
 */
export function writeExportFile(dir: string, title: string, extension: string, data: Buffer | string, fallback = "export"): { fileName: string; bytes: number } {
  let stat: fs.Stats;
  try { stat = fs.statSync(dir); } catch { throw new MangaError("NOT_FOUND", "the folder for the export is not there", { details: { reason: "missing-dir" } }); }
  if (!stat.isDirectory()) throw new MangaError("VALIDATION_ERROR", "the export needs a folder");
  const base = safeFileName(title, fallback);
  let candidate = `${base}.${extension}`;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n += 1) {
    if (n > 999) throw new MangaError("VALIDATION_ERROR", "there are too many files with this name");
    candidate = `${base} (${n}).${extension}`;
  }
  const temporary = path.join(dir, `.${candidate}.part`);
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  try {
    fs.writeFileSync(temporary, buffer, { flag: "wx" });
    fs.renameSync(temporary, path.join(dir, candidate));
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* nothing to clean */ }
    throw new MangaError("LOCATION_UNAVAILABLE", `the export could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { fileName: candidate, bytes: buffer.length };
}
