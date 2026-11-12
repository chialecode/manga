// Pinned external tools (FFmpeg, Silero VAD, subtitle font, GTCRN denoiser, gate ASR model) are downloaded from
// addresses in scripts/tools/*.lock.json.
// Two checks keep those addresses durable for local verification and weekly releases:
//   --pins (offline, run by verify, includes negative self-test):
//          - FFmpeg must pin a month-end autobuild tag (daily builds expire after ~2 weeks; month-end builds stay);
//          - every other URL must EITHER pin a full 40-char commit hash in its URL path (with 64-hex sha256) OR pin an
//            explicit GitHub release tag + safe asset filename + 64-hex sha256 + positive byte count.
//   default (online, run by release.yml `decide` before a Windows runner is taken, and locally before push):
//          send a HEAD request to every address, following redirects, and fail naming any tool that no longer answers 2xx.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LOCK_FILES = [
  "ffmpeg.lock.json",
  "silero-vad.lock.json",
  "subtitle-font.lock.json",
  "gtcrn.lock.json",
  "speech-asr.lock.json",
];

function readLock(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, "scripts", "tools", name), "utf8"));
}

function readAllLocks(root) {
  const map = {};
  for (const name of LOCK_FILES) map[name] = readLock(root, name);
  return map;
}

function collectLockLinksFromMap(locksByFile) {
  const links = [];
  const visit = (tool, value, where, parent) => {
    if (typeof value === "string" && /^https?:\/\//.test(value) && /(?:^|\.)url$/i.test(where)) {
      links.push({ tool, where, url: value, node: parent });
    } else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) visit(tool, inner, where ? `${where}.${key}` : key, value);
    }
  };
  for (const [name, content] of Object.entries(locksByFile)) {
    if (content) visit(name, content, "", null);
  }
  return links;
}

/** Every download address in the lock files, labelled by tool and field path. */
export function lockLinks(root = defaultRoot) {
  return collectLockLinksFromMap(readAllLocks(root)).map(({ tool, where, url }) => ({ tool, where, url }));
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

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True when a non-FFmpeg link pins a GitHub release asset with explicit tag, matching asset name, 64-hex SHA-256 and positive byte size.
 */
export function isPinnedReleaseAsset(linkUrl, node) {
  if (!node || typeof node !== "object") return false;
  let parsed;
  try {
    parsed = new URL(linkUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return false;
  const match = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return false;
  const [, urlTag, urlAsset] = match;
  if (!urlTag || urlTag === "latest") return false;
  if (!SAFE_ASSET_NAME.test(urlAsset) || urlAsset.includes("..")) return false;
  if (typeof node.tag !== "string" || node.tag !== urlTag) return false;
  if (typeof node.asset !== "string" || node.asset !== urlAsset) return false;
  if (typeof node.sha256 !== "string" || !HEX_64.test(node.sha256)) return false;
  if (typeof node.bytes !== "number" || !Number.isInteger(node.bytes) || node.bytes <= 0) return false;
  return true;
}

export function validateLockMap(locksByFile) {
  const problems = [];
  const ffmpeg = locksByFile["ffmpeg.lock.json"];
  if (!ffmpeg) {
    problems.push("ffmpeg.lock.json: missing lock file");
  } else {
    if (!isMonthEndAutobuild(ffmpeg.source?.tag)) {
      problems.push(`ffmpeg.lock.json: tag ${JSON.stringify(ffmpeg.source?.tag)} is not a month-end autobuild-YYYY-MM-DD-HH-MM (daily builds are deleted after about two weeks)`);
    }
    if (typeof ffmpeg.source?.url !== "string" || !ffmpeg.source.url.includes(`/releases/download/${ffmpeg.source?.tag}/`)) {
      problems.push("ffmpeg.lock.json: url does not download from the pinned tag");
    }
  }

  for (const link of collectLockLinksFromMap(locksByFile).filter((entry) => entry.tool !== "ffmpeg.lock.json")) {
    let segments = [];
    try {
      segments = new URL(link.url).pathname.split("/");
    } catch {
      problems.push(`${link.tool}: ${link.where} is not a valid URL (${link.url})`);
      continue;
    }
    const hasCommitPin = segments.some((segment) => /^[0-9a-f]{40}$/.test(segment));
    if (hasCommitPin) {
      if (typeof link.node?.sha256 !== "string" || !HEX_64.test(link.node.sha256)) {
        problems.push(`${link.tool}: ${link.where} is missing a 64-character lowercase hex sha256`);
      }
      continue;
    }
    if (isPinnedReleaseAsset(link.url, link.node)) continue;
    problems.push(
      `${link.tool}: ${link.where} must be pinned either to a 40-character commit hash or to a GitHub release tag + matching asset name + 64-hex sha256 + bytes (${link.url})`,
    );
  }
  return problems;
}

/** Offline checks of the pins; returns a list of problems (empty when every pin is durable). */
export function checkLockPins(root = defaultRoot) {
  return validateLockMap(readAllLocks(root));
}

/** Negative self-test proving bad commit pins, floating release tags, mismatched asset names, and bad SHA-256s are rejected. */
export function selfTest(baseLocks = readAllLocks(defaultRoot)) {
  const clone = () => structuredClone(baseLocks);

  // 1. Baseline must pass.
  const baseline = validateLockMap(clone());
  if (baseline.length > 0) throw new Error(`check-tool-links self-test baseline failed: ${baseline.join("; ")}`);

  // 2. Branch name instead of 40-char commit hash must fail.
  const badCommit = clone();
  badCommit["gtcrn.lock.json"].files.LICENSE.url = "https://raw.githubusercontent.com/Xiaobin-Rong/gtcrn/main/LICENSE";
  if (!validateLockMap(badCommit).some((p) => p.includes("gtcrn.lock.json") && p.includes("LICENSE.url"))) {
    throw new Error("check-tool-links self-test failed to reject branch URL in gtcrn.lock.json");
  }

  // 3. Release asset missing or mismatched asset name must fail.
  const badAsset = clone();
  badAsset["speech-asr.lock.json"].source.asset = "wrong-name.tar.bz2";
  if (!validateLockMap(badAsset).some((p) => p.includes("speech-asr.lock.json"))) {
    throw new Error("check-tool-links self-test failed to reject mismatched release asset name");
  }

  // 4. Release asset with invalid/short SHA-256 must fail.
  const badSha = clone();
  badSha["gtcrn.lock.json"].files["gtcrn_simple.onnx"].sha256 = "deadbeef";
  if (!validateLockMap(badSha).some((p) => p.includes("gtcrn.lock.json") && p.includes("gtcrn_simple.onnx"))) {
    throw new Error("check-tool-links self-test failed to reject invalid release asset sha256");
  }

  // 5. Floating 'latest' release tag must fail.
  const floatingRelease = clone();
  floatingRelease["gtcrn.lock.json"].files["gtcrn_simple.onnx"].tag = "latest";
  floatingRelease["gtcrn.lock.json"].files["gtcrn_simple.onnx"].url =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/latest/gtcrn_simple.onnx";
  if (!validateLockMap(floatingRelease).some((p) => p.includes("gtcrn.lock.json"))) {
    throw new Error("check-tool-links self-test failed to reject floating latest release tag");
  }
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
  if (pins.length === 0) selfTest();
  if (process.argv.includes("--pins")) {
    if (pins.length === 0) console.log(JSON.stringify({ check: "tool-pins", status: "passed", selfTest: "passed" }));
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
