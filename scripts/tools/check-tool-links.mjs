// The three pinned tools (FFmpeg, Silero VAD, the subtitle font) are downloaded from addresses in scripts/tools/*.lock.json.
// Two checks keep those addresses alive for the weekly release:
//   --pins (offline, run by verify): the FFmpeg tag must be a month-end autobuild (daily builds are deleted after about two
//          weeks; month-end builds stay), and every other address must be pinned to a full 40-character commit hash.
//   default (online, run by release.yml `decide` before a Windows runner is taken, and locally before a push): send a HEAD
//          request to every address, following redirects, and fail naming the tool whose address no longer answers 2xx.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCKS = ["ffmpeg.lock.json", "silero-vad.lock.json", "subtitle-font.lock.json"];

function readLock(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, "scripts", "tools", name), "utf8"));
}

/** Every download address in the three lock files, labelled by tool and file. */
export function lockLinks(root = defaultRoot) {
  const links = [];
  const visit = (tool, value, where) => {
    if (typeof value === "string" && /^https?:\/\//.test(value) && /(?:^|\.)url$/i.test(where)) links.push({ tool, where, url: value });
    else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) visit(tool, inner, where ? `${where}.${key}` : key);
  };
  for (const name of LOCKS) visit(name, readLock(root, name), "");
  return links;
}

/** True when `tag` is `autobuild-YYYY-MM-DD-HH-MM` and the date is the last day of its month. */
export function isMonthEndAutobuild(tag) {
  const match = /^autobuild-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(String(tag));
  if (!match) return false;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day === lastDay;
}

/** Offline checks of the pins; returns a list of problems (empty when every pin is durable). */
export function checkLockPins(root = defaultRoot) {
  const problems = [];
  const ffmpeg = readLock(root, "ffmpeg.lock.json");
  if (!isMonthEndAutobuild(ffmpeg.source?.tag)) problems.push(`ffmpeg.lock.json: tag ${JSON.stringify(ffmpeg.source?.tag)} is not a month-end autobuild-YYYY-MM-DD-HH-MM (daily builds are deleted after about two weeks)`);
  if (typeof ffmpeg.source?.url !== "string" || !ffmpeg.source.url.includes(`/releases/download/${ffmpeg.source?.tag}/`)) problems.push("ffmpeg.lock.json: url does not download from the pinned tag");
  for (const link of lockLinks(root).filter((entry) => entry.tool !== "ffmpeg.lock.json")) {
    const segments = new URL(link.url).pathname.split("/");
    if (!segments.some((segment) => /^[0-9a-f]{40}$/.test(segment))) problems.push(`${link.tool}: ${link.where} is not pinned to a 40-character commit hash (${link.url})`);
  }
  return problems;
}

/** HEAD every address; `fetchImpl` is injectable for tests. Returns one entry per address. */
export async function checkLinksOnline(root = defaultRoot, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const results = [];
  for (const link of lockLinks(root)) {
    try {
      const response = await fetchImpl(link.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      results.push({ ...link, status: response.status, ok: response.status >= 200 && response.status < 300 });
    } catch (error) {
      results.push({ ...link, status: 0, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pins = checkLockPins();
  for (const problem of pins) console.error(`FAILED tool pin: ${problem}`);
  if (process.argv.includes("--pins")) {
    if (pins.length === 0) console.log(JSON.stringify({ check: "tool-pins", status: "passed" }));
    process.exitCode = pins.length ? 1 : 0;
  } else {
    const results = await checkLinksOnline();
    for (const result of results) {
      const line = `${result.ok ? "ok  " : "GONE"} ${result.status} ${result.tool} ${result.where} ${result.url}${result.error ? ` (${result.error})` : ""}`;
      if (result.ok) console.log(line);
      else console.error(line);
    }
    const gone = results.filter((result) => !result.ok);
    if (gone.length > 0) console.error(`FAILED tool links: ${gone.map((result) => `${result.tool} ${result.where}`).join("; ")} no longer download; re-pin the lock file before releasing`);
    process.exitCode = gone.length || pins.length ? 1 : 0;
  }
}
