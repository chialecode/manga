import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function matchActionPattern(actionRef, pattern) {
  const [refRepo] = actionRef.split("@");
  const [patRepo, patVer] = pattern.split("@");
  if (!refRepo || !patRepo || refRepo !== patRepo) return false;
  return patVer === "*" || actionRef === pattern;
}

function extractJobsBlocks(yamlText) {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  const jobsIdx = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIdx < 0) return {};

  const jobs = {};
  let currentJob = null;
  let currentLines = [];

  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && !line.startsWith("#")) {
      break;
    }
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      if (currentJob) {
        jobs[currentJob] = currentLines.join("\n");
      }
      currentJob = jobMatch[1];
      currentLines = [line];
    } else if (currentJob) {
      currentLines.push(line);
    }
  }
  if (currentJob) {
    jobs[currentJob] = currentLines.join("\n");
  }
  return jobs;
}

function extractStepsFromJobBlock(jobBlock) {
  const lines = jobBlock.replace(/\r\n/g, "\n").split("\n");
  const stepsIdx = lines.findIndex((line) => /^    steps:\s*$/.test(line));
  if (stepsIdx < 0) return [];

  const steps = [];
  let current = [];
  for (let i = stepsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^    [A-Za-z0-9_-]+:/.test(line)) break;
    if (/^      - /.test(line)) {
      if (current.length > 0) steps.push(current.join("\n"));
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }
  if (current.length > 0) steps.push(current.join("\n"));
  return steps;
}

/**
 * Validate `.github/workflows/ci.yml` and `.github/workflows/release.yml` against `.github/actions-policy.json`
 * and the Stage M10 security boundaries (计划 4.9, AT-163).
 */
export function validateWorkflows({
  root = rootDir,
  policy,
  ciYamlText,
  releaseYamlText,
} = {}) {
  const errors = [];
  const loadedPolicy = policy ?? JSON.parse(fs.readFileSync(path.join(root, ".github/actions-policy.json"), "utf8"));
  const ciText = ciYamlText ?? fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const releaseText = releaseYamlText ?? fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");

  const allowedPatterns = loadedPolicy?.selectedActions?.patterns_allowed ?? [];
  if (loadedPolicy?.permissions?.sha_pinning_required !== true) {
    errors.push("actions-policy.json: sha_pinning_required must be true");
  }
  for (const requiredPattern of [
    "actions/checkout@*",
    "actions/setup-node@*",
    "actions/upload-artifact@*",
    "actions/download-artifact@*",
  ]) {
    if (!allowedPatterns.includes(requiredPattern)) {
      errors.push(`actions-policy.json: missing allowed pattern ${requiredPattern}`);
    }
  }

  // Validate all `uses:` across both workflows are 40-char SHA pinned and in the allowlist.
  for (const [name, text] of [["ci.yml", ciText], ["release.yml", releaseText]]) {
    const usesMatches = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)];
    if (usesMatches.length === 0) {
      errors.push(`${name}: no action uses found`);
    }
    for (const match of usesMatches) {
      const ref = match[1].trim().replace(/^['"]|['"]$/g, "");
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(ref)) {
        errors.push(`${name}: action "${ref}" is not pinned to a full 40-character commit SHA`);
      }
      if (!allowedPatterns.some((pattern) => matchActionPattern(ref, pattern))) {
        errors.push(`${name}: action "${ref}" is not in actions-policy.json patterns_allowed`);
      }
    }
  }

  // Validate ci.yml invariants
  if (/\bsecrets\./.test(ciText)) {
    errors.push("ci.yml: must not reference secrets");
  }
  if (/^\s*schedule:/m.test(ciText)) {
    errors.push("ci.yml: must not use schedule trigger");
  }

  // Validate release.yml triggers (only schedule and workflow_dispatch, never push or pull_request)
  const normalizedRelease = releaseText.replace(/\r\n/g, "\n");
  if (!/^\s*schedule:\s*\n\s*-\s*cron:\s*["']0 0 \* \* 1["']/m.test(normalizedRelease)) {
    errors.push("release.yml: missing Monday 00:00 UTC schedule cron '0 0 * * 1'");
  }
  if (!/^\s*workflow_dispatch:/m.test(normalizedRelease)) {
    errors.push("release.yml: missing workflow_dispatch trigger");
  }
  if (!/dry_run:\s*\n(?:\s+.*\n)*?\s+default:\s*true\b/m.test(normalizedRelease)) {
    errors.push("release.yml: workflow_dispatch.inputs.dry_run must default to true");
  }
  for (const forbiddenTrigger of ["push", "pull_request", "pull_request_target", "issue_comment", "discussion"]) {
    const triggerRe = new RegExp(`^  ${forbiddenTrigger}:`, "m");
    if (triggerRe.test(normalizedRelease)) {
      errors.push(`release.yml: forbidden trigger "${forbiddenTrigger}" present`);
    }
  }

  // Top-level permissions & concurrency
  if (!/^permissions:\s*\{\s*\}\s*$/m.test(normalizedRelease)) {
    errors.push("release.yml: top-level permissions must be {}");
  }
  if (!/^concurrency:\s*\n\s+group:\s*release\s*\n\s+cancel-in-progress:\s*false\b/m.test(normalizedRelease)) {
    errors.push("release.yml: concurrency must be group: release with cancel-in-progress: false");
  }

  const jobs = extractJobsBlocks(normalizedRelease);
  // PowerShell does not stop on a native program's nonzero exit. Every command in
  // a Windows release step must propagate it before the following command can run.
  for (const [jobName, block] of Object.entries(jobs)) {
    if (!/^    runs-on:\s*windows-/m.test(block)) continue;
    for (const step of extractStepsFromJobBlock(block)) {
      const run = step.split(/^        run:\s*\|\s*$/m)[1];
      if (!run) continue;
      const lines = run.split("\n").map((line) => line.trim()).filter(Boolean);
      for (let index = 0; index < lines.length; index += 1) {
        if (/^(?:node|pnpm|corepack)\s/.test(lines[index]) && !/^if\s*\(\$LASTEXITCODE -ne 0\)\s*\{\s*exit \$LASTEXITCODE\s*\}$/.test(lines[index + 1] ?? "")) {
          errors.push(`release.yml: ${jobName} native command does not propagate failure: ${lines[index]}`);
        }
      }
    }
  }
  for (const requiredJob of ["decide", "check", "build", "publish"]) {
    if (!jobs[requiredJob]) {
      errors.push(`release.yml: missing job "${requiredJob}"`);
    }
  }

  // Job `decide` checks
  if (jobs.decide) {
    if (!/^\s{4}runs-on:\s*ubuntu-24\.04\s*$/m.test(jobs.decide)) {
      errors.push("release.yml: job decide must run on ubuntu-24.04");
    }
    if (!/^\s{4}permissions:\s*\n\s{6}contents:\s*read\s*$/m.test(jobs.decide)) {
      errors.push("release.yml: job decide must have permissions: { contents: read }");
    }
    if (/^\s{4}environment:/m.test(jobs.decide)) {
      errors.push("release.yml: job decide must not use an environment");
    }
    if (/\bsecrets\./.test(jobs.decide)) {
      errors.push("release.yml: job decide must not access secrets");
    }
    if (/\b(?:pnpm|npm|yarn)\s+install\b/.test(jobs.decide)) {
      errors.push("release.yml: job decide must not install dependencies");
    }
  }

  // Job `check` checks
  if (jobs.check) {
    if (!/^\s{4}runs-on:\s*windows-2025\s*$/m.test(jobs.check)) {
      errors.push("release.yml: job check must run on windows-2025 (never windows-latest)");
    }
    if (!/^\s{4}permissions:\s*\n\s{6}contents:\s*read\s*$/m.test(jobs.check)) {
      errors.push("release.yml: job check must have permissions: { contents: read }");
    }
    if (/^\s{4}environment:/m.test(jobs.check)) {
      errors.push("release.yml: job check must not use any environment");
    }
    if (/\bsecrets\./.test(jobs.check)) {
      errors.push("release.yml: job check must not reference any secrets");
    }
    if (!/^\s{4}if:\s*needs\.decide\.outputs\.should_release\s*==\s*'true'/m.test(jobs.check)) {
      errors.push("release.yml: job check must be gated on needs.decide.outputs.should_release == 'true'");
    }
  }

  // Job `build` checks
  if (jobs.build) {
    if (!/^\s{4}runs-on:\s*windows-2025\s*$/m.test(jobs.build)) {
      errors.push("release.yml: job build must run on windows-2025");
    }
    if (!/^\s{4}environment:\s*release\s*$/m.test(jobs.build)) {
      errors.push("release.yml: job build must declare environment: release");
    }
    if (!/^\s{4}permissions:\s*\n\s{6}contents:\s*read\s*$/m.test(jobs.build)) {
      errors.push("release.yml: job build must have permissions: { contents: read } (no write permission)");
    }
    if (!/needs:\s*\[decide,\s*check\]/.test(jobs.build)) {
      errors.push("release.yml: job build must depend on [decide, check]");
    }
    const buildSteps = extractStepsFromJobBlock(jobs.build);
    for (const stepText of buildSteps) {
      const secretRefs = [...stepText.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      if (secretRefs.length === 0) continue;
      const isPackageStep = /^\s+id:\s*package-release\s*$/m.test(stepText);
      const isStageReleaseStep = /^\s+id:\s*stage-release\s*$/m.test(stepText);
      if (isPackageStep) {
        if (secretRefs.length !== 1 || secretRefs[0] !== "MANGA_PLUGIN_SIGNING_KEY_PEM") {
          errors.push(`release.yml: build step package-release may only reference MANGA_PLUGIN_SIGNING_KEY_PEM (got ${secretRefs.join(", ")})`);
        }
      } else if (isStageReleaseStep) {
        if (secretRefs.length !== 1 || secretRefs[0] !== "MANGA_UPDATE_SIGNING_KEY_PEM") {
          errors.push(`release.yml: build step stage-release may only reference MANGA_UPDATE_SIGNING_KEY_PEM (got ${secretRefs.join(", ")})`);
        }
      } else {
        errors.push(`release.yml: secret ${secretRefs.join(", ")} referenced in an unauthorized step of build`);
      }
    }
    if (!jobs.build.includes("secrets.MANGA_PLUGIN_SIGNING_KEY_PEM")) {
      errors.push("release.yml: job build is missing MANGA_PLUGIN_SIGNING_KEY_PEM in package-release step");
    }
    if (!jobs.build.includes("secrets.MANGA_UPDATE_SIGNING_KEY_PEM")) {
      errors.push("release.yml: job build is missing MANGA_UPDATE_SIGNING_KEY_PEM in stage-release step");
    }
  }

  // Job `publish` checks
  if (jobs.publish) {
    if (!/^\s{4}runs-on:\s*ubuntu-24\.04\s*$/m.test(jobs.publish)) {
      errors.push("release.yml: job publish must run on ubuntu-24.04");
    }
    if (!/^\s{4}permissions:\s*\n\s{6}contents:\s*write\s*$/m.test(jobs.publish)) {
      errors.push("release.yml: job publish must have permissions: { contents: write }");
    }
    if (/^\s{4}environment:/m.test(jobs.publish)) {
      errors.push("release.yml: job publish must not use an environment");
    }
    if (/\bsecrets\./.test(jobs.publish)) {
      errors.push("release.yml: job publish must not reference any secrets");
    }
    if (/\b(?:pnpm|npm|yarn)\s+install\b|\bcorepack\b/.test(jobs.publish)) {
      errors.push("release.yml: job publish must not install dependencies or enable corepack");
    }
    if (!jobs.publish.includes("inputs.dry_run")) {
      errors.push("release.yml: job publish must skip when workflow_dispatch inputs.dry_run is true");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateWorkflows();
  if (!result.ok) {
    for (const err of result.errors) console.error(`FAILED workflow check: ${err}`);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ check: "workflows", status: "passed" }));
  }
}
