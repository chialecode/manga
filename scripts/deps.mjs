import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * node scripts/deps.mjs [--json]   dependency inventory, run when a stage starts and again before the stage gate
 * node scripts/deps.mjs --audit    known vulnerabilities only; the stage gate runs this and fails on it
 *
 * The inventory lists every direct dependency with a newer stable version that is at least minimumReleaseAge old
 * (pnpm-workspace.yaml, the same age Dependabot's cooldown uses), split into same-major updates and major updates.
 * It only reports; what to upgrade is decided in the stage plan (development workflow, dependency inventory).
 *
 * The audit fails (exit 1) on any advisory that is not listed in scripts/deps-exceptions.json, and on an exception
 * whose reviewBy date has passed. Exit 2 means the check could not run (no network, registry error): record it as
 * not run, never as passed.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const DAY = 24 * 60 * 60 * 1000;

function minimumAgeDays() {
  const text = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const minutes = Number(/^minimumReleaseAge:\s*(\d+)\s*$/m.exec(text)?.[1]);
  if (!minutes) throw new Error("pnpm-workspace.yaml declares no minimumReleaseAge");
  return minutes / (24 * 60);
}

function pnpm(pnpmArgs) {
  // pnpm is a .cmd shim on Windows, so it runs through the shell; the arguments are fixed strings from this file.
  const result = spawnSync(`pnpm ${pnpmArgs.join(" ")}`, { cwd: root, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`pnpm ${pnpmArgs.join(" ")} gave no JSON (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
}

/** [major, minor, patch] of a stable version; null for prereleases and anything else. */
function stable(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return match ? match.slice(1).map(Number) : null;
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function inventory() {
  const ageDays = minimumAgeDays();
  const now = Date.now();
  const outdated = pnpm(["outdated", "-r", "--format", "json"]);
  const rows = await mapLimit(Object.entries(outdated), 6, async ([name, info]) => {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { headers: { "user-agent": "dependency-inventory" } });
    if (!response.ok) throw new Error(`registry ${name}: HTTP ${response.status}`);
    const doc = await response.json();
    const current = stable(info.current);
    const mature = Object.entries(doc.time ?? {})
      .map(([version, at]) => ({ version, parts: stable(version), days: (now - Date.parse(at)) / DAY }))
      .filter((item) => item.parts && !doc.versions?.[item.version]?.deprecated)
      .sort((a, b) => compare(b.parts, a.parts));
    const newest = mature[0];
    const ripe = mature.filter((item) => item.days >= ageDays);
    const sameMajor = current && ripe.find((item) => item.parts[0] === current[0] && compare(item.parts, current) > 0);
    const major = current && ripe.find((item) => item.parts[0] > current[0]);
    return {
      name,
      current: info.current,
      type: info.dependencyType,
      usedBy: (info.dependentPackages ?? []).map((item) => item.name),
      sameMajor: sameMajor?.version ?? null,
      major: major?.version ?? null,
      newest: newest?.version ?? null,
      newestDays: newest ? Math.floor(newest.days) : null,
    };
  });
  const due = rows.filter((row) => row.sameMajor || row.major);
  const waiting = rows.filter((row) => !row.sameMajor && !row.major && row.newest && row.newest !== row.current);
  if (args.has("--json")) {
    console.log(JSON.stringify({ check: "dependency-inventory", minimumAgeDays: ageDays, due, waiting }, null, 2));
    return 0;
  }
  console.log(`[deps] newer stable versions at least ${ageDays} days old (direct dependencies):`);
  for (const row of due) {
    console.log(`  ${row.name} ${row.current} -> ${row.sameMajor ?? "-"} (same major)${row.major ? `, ${row.major} (major)` : ""}  [${row.type}; ${row.usedBy.join(", ")}]`);
  }
  if (!due.length) console.log("  none");
  if (waiting.length) {
    console.log(`[deps] newer, but younger than ${ageDays} days (not due yet):`);
    for (const row of waiting) console.log(`  ${row.name} ${row.current} -> ${row.newest} (${row.newestDays} days)`);
  }
  console.log(JSON.stringify({ status: "reported", check: "dependency-inventory", due: due.length, waiting: waiting.length }));
  return 0;
}

function audit() {
  const exceptionsFile = path.join(root, "scripts/deps-exceptions.json");
  const exceptions = JSON.parse(fs.readFileSync(exceptionsFile, "utf8")).exceptions ?? [];
  const report = pnpm(["audit", "--json"]);
  if (!report.advisories) throw new Error(`pnpm audit returned no advisories field: ${JSON.stringify(report).slice(0, 300)}`);
  const today = new Date().toISOString().slice(0, 10);
  const found = Object.values(report.advisories).map((item) => ({
    id: item.github_advisory_id ?? String(item.id),
    module: item.module_name,
    severity: item.severity,
    title: item.title,
    patched: item.patched_versions,
    versions: [...new Set(item.findings.map((finding) => finding.version))],
    dev: item.findings.every((finding) => finding.dev),
    path: item.findings[0]?.paths?.[0],
  }));
  const excepted = new Map(exceptions.map((item) => [item.advisory, item]));
  const open = found.filter((item) => !excepted.has(item.id));
  const expired = exceptions.filter((item) => !item.reviewBy || item.reviewBy < today);
  const unused = exceptions.filter((item) => !found.some((advisory) => advisory.id === item.advisory));
  for (const item of open) {
    console.error(`[deps] ${item.severity} ${item.id} ${item.module}@${item.versions.join(",")}${item.dev ? " (dev)" : ""}: ${item.title}; fixed in ${item.patched ?? "no release yet"}; via ${item.path}`);
  }
  for (const item of expired) console.error(`[deps] exception ${item.advisory} (${item.package}) passed its reviewBy date ${item.reviewBy}`);
  for (const item of unused) console.log(`[deps] exception ${item.advisory} (${item.package}) no longer matches an advisory: remove it`);
  const ok = !open.length && !expired.length;
  console.log(JSON.stringify({ status: ok ? "passed" : "failed", check: "dependency-audit", advisories: found.length, excepted: found.length - open.length, open: open.length, expiredExceptions: expired.length }));
  return ok ? 0 : 1;
}

try {
  process.exitCode = args.has("--audit") ? audit() : await inventory();
} catch (error) {
  console.error(`[deps] not run: ${error instanceof Error ? error.message : String(error)}`);
  console.log(JSON.stringify({ status: "not-run", check: args.has("--audit") ? "dependency-audit" : "dependency-inventory" }));
  process.exitCode = 2;
}
