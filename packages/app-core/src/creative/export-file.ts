import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MangaError, createId } from "@manga/contracts";
import { placeNoReplace, TargetTaken } from "../acquisition/files.ts";

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export type ExportFileIntent = {
  finalPath: string;
  temporaryPath: string;
  fileName: string;
  bytes: number;
  sha256: string;
};

/** The host may journal publication so a confirmed export can be recovered without making another copy. */
export type ExportFileHooks = {
  beforePublish: (intent: ExportFileIntent) => void;
  afterPublish: (intent: ExportFileIntent) => void;
};

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
export function writeExportFile(dir: string, title: string, extension: string, data: Buffer | string, fallback = "export", hooks?: ExportFileHooks): { fileName: string; bytes: number } {
  let stat: fs.Stats;
  try { stat = fs.statSync(dir); } catch { throw new MangaError("NOT_FOUND", "the folder for the export is not there", { details: { reason: "missing-dir" } }); }
  if (!stat.isDirectory()) throw new MangaError("VALIDATION_ERROR", "the export needs a folder");
  const base = safeFileName(title, fallback);
  const temporary = path.join(dir, `.manga-export-${createId("file")}.part`);
  const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let temporaryCreated = false;
  try {
    fs.writeFileSync(temporary, buffer, { flag: "wx" });
    temporaryCreated = true;
    const sha256 = hooks ? createHash("sha256").update(buffer).digest("hex") : "";
    for (let n = 1; n <= 999; n += 1) {
      const candidate = n === 1 ? `${base}.${extension}` : `${base} (${n}).${extension}`;
      const finalPath = path.join(dir, candidate);
      if (fs.existsSync(finalPath)) continue;
      const intent = { finalPath, temporaryPath: temporary, fileName: candidate, bytes: buffer.length, sha256 };
      hooks?.beforePublish(intent);
      try {
        placeNoReplace(temporary, finalPath);
      } catch (error) {
        if (error instanceof TargetTaken) continue;
        throw error;
      }
      hooks?.afterPublish(intent);
      return { fileName: candidate, bytes: buffer.length };
    }
    throw new MangaError("VALIDATION_ERROR", "there are too many files with this name");
  } catch (error) {
    if (temporaryCreated) try { fs.rmSync(temporary, { force: true }); } catch { /* nothing to clean */ }
    if (error instanceof MangaError) throw error;
    throw new MangaError("LOCATION_UNAVAILABLE", `the export could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
}
