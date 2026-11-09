import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_TAG_RE = /^v?0\.1\.(\d+)$/;

/**
 * Parse and sort `v0.1.<patch>` tags in descending order of `<patch>` (highest first).
 */
export function parseReleaseTags(tags = []) {
  const parsed = [];
  for (const raw of tags) {
    const trimmed = String(raw ?? "").trim();
    const match = RELEASE_TAG_RE.exec(trimmed);
    if (!match) continue;
    const patch = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(patch) || patch < 0) continue;
    parsed.push({
      tag: `v0.1.${patch}`,
      version: `0.1.${patch}`,
      patch,
    });
  }
  parsed.sort((a, b) => b.patch - a.patch);
  return parsed;
}

/**
 * Normalize a commit entry (`"<sha>\t<subject>"`, `"<subject>"`, or `{ sha, subject, prNumber }`) and extract PR metadata.
 */
export function extractCommitInfo(entry, repository = "chialecode/manga") {
  let sha = "";
  let subject = "";
  let explicitPr = null;

  if (typeof entry === "string") {
    const tabIdx = entry.indexOf("\t");
    if (tabIdx > 0 && /^[0-9a-f]{7,40}$/i.test(entry.slice(0, tabIdx).trim())) {
      sha = entry.slice(0, tabIdx).trim();
      subject = entry.slice(tabIdx + 1).trim();
    } else {
      subject = entry.trim();
    }
  } else if (entry && typeof entry === "object") {
    sha = String(entry.sha ?? "").trim();
    subject = String(entry.subject ?? entry.title ?? "").trim();
    if (Number.isInteger(entry.prNumber) && entry.prNumber > 0) {
      explicitPr = entry.prNumber;
    } else if (Number.isInteger(entry.number) && entry.number > 0) {
      explicitPr = entry.number;
    }
  }

  const prMatch = /\(#(\d+)\)\s*$/.exec(subject) ?? /Merge pull request #(\d+)\b/i.exec(subject);
  const prNumber = explicitPr ?? (prMatch ? Number.parseInt(prMatch[1], 10) : null);
  const cleanTitle = subject.replace(/\s*\(#\d+\)\s*$/, "").trim() || subject;
  const prUrl = prNumber ? `https://github.com/${repository}/pull/${prNumber}` : null;
  const shortSha = sha ? sha.slice(0, 7) : null;

  return {
    sha: sha || null,
    shortSha,
    subject,
    cleanTitle,
    prNumber,
    prUrl,
  };
}

/**
 * Generate Chinese release notes (`RELEASE-NOTES.md`) from merged PRs/commits and release metadata (计划 4.5, 4.9).
 */
export function formatReleaseNotesMarkdown({
  version,
  previousTag = null,
  commits = [],
  repository = "chialecode/manga",
  schemaVersion = null,
  previousSchemaVersion = null,
  willUpgradeSchema = false,
  ciMode = false,
  benchFingerprint = null,
  benchMatchesSource = false,
} = {}) {
  const lines = [`# MANGA v${version} 发布说明`, ""];

  const upgradesSchema = Boolean(
    willUpgradeSchema
    || (Number.isInteger(schemaVersion) && Number.isInteger(previousSchemaVersion) && schemaVersion > previousSchemaVersion),
  );
  if (upgradesSchema) {
    lines.push(
      `> **重要提示（资料库升级）**：本版本会将资料库结构升级至 v${schemaVersion ?? "最新"}。启动或安装更新前会自动备份现有数据库，确保数据可回退。`,
      "",
    );
  }

  lines.push("## 本次合并的更新", "");
  if (previousTag) {
    lines.push(`自 \`${previousTag}\` 以来合并至 \`main\` 的变更：`, "");
  } else {
    lines.push("首次正式版发布包含的主要变更：", "");
  }

  const normalized = commits.map((item) => (item && typeof item === "object" && "cleanTitle" in item ? item : extractCommitInfo(item, repository)));
  if (normalized.length === 0) {
    lines.push("- 常规维护与构建验证更新。");
  } else {
    for (const item of normalized) {
      if (item.prNumber && item.prUrl) {
        lines.push(`- ${item.cleanTitle}（[PR #${item.prNumber}](${item.prUrl})${item.shortSha ? ` · \`${item.shortSha}\`` : ""}）`);
      } else if (item.shortSha) {
        lines.push(`- ${item.cleanTitle}（\`${item.shortSha}\`）`);
      } else {
        lines.push(`- ${item.cleanTitle}`);
      }
    }
  }

  lines.push("", "## 验证与说明", "");
  lines.push("- **安装与更新校验**：安装包附带独立 Ed25519 签名（`.sig`）与 `SHA256SUMS`，应用内更新强制校验签名、版本与文件 SHA-512。");
  if (ciMode) {
    lines.push(
      `- **性能基准说明**：本次构建在 GitHub Actions 标准运行器上未运行性能基准；基准结论以最近一次本地门禁证据为准${benchFingerprint ? `（基准源码指纹：\`${benchFingerprint.slice(0, 12)}\`，与本次发布源码一致：${benchMatchesSource ? "是" : "否"}）` : ""}。`,
    );
  } else if (benchFingerprint) {
    lines.push(
      `- **性能基准说明**：本地门禁基准源码指纹 \`${benchFingerprint.slice(0, 12)}\`（与本次发布源码一致：${benchMatchesSource ? "是" : "否"}）。`,
    );
  }
  lines.push("- **人工检查状态**：发布相关人工检查项与状态见仓库 `USER-ACTIONS.md`。");

  return `${lines.join("\n")}\n`;
}

/**
 * Pure decision function for the weekly release workflow `decide` job (计划 4.9, AT-163):
 * - No `v0.1.*` tag yet -> `shouldRelease: true`, `version: "0.1.1"`.
 * - Highest `v0.1.*` tag has 0 commits after it -> `shouldRelease: false`, `reason: "本周没有新的合并"`.
 * - Highest `v0.1.*` tag has >= 1 commits after it -> `shouldRelease: true`, `version: "0.1.<highest + 1>"`, lists merged PRs/commits.
 */
export function decideWeeklyRelease({
  tags = [],
  commitsSinceTag = [],
  headSha = "",
  repository = "chialecode/manga",
  schemaVersion = 15,
  previousSchemaVersion = null,
  willUpgradeSchema = false,
  ciMode = true,
} = {}) {
  const sortedTags = parseReleaseTags(tags);
  const highest = sortedTags[0] ?? null;
  const commits = commitsSinceTag
    .filter((entry) => entry !== null && entry !== undefined && String(entry).trim() !== "")
    .map((entry) => extractCommitInfo(entry, repository));
  const pullRequests = commits
    .filter((item) => item.prNumber !== null)
    .map((item) => ({
      number: item.prNumber,
      title: item.cleanTitle,
      url: item.prUrl,
      sha: item.sha,
    }));

  if (!highest) {
    const version = "0.1.1";
    const tag = "v0.1.1";
    const notesMarkdown = formatReleaseNotesMarkdown({
      version,
      previousTag: null,
      commits,
      repository,
      schemaVersion,
      previousSchemaVersion,
      willUpgradeSchema,
      ciMode,
    });
    return {
      shouldRelease: true,
      version,
      tag,
      previousTag: null,
      headSha: headSha || null,
      reason: "首次正式版发布（尚无 v0.1.* 标签）",
      commits,
      pullRequests,
      notesMarkdown,
    };
  }

  if (commits.length === 0) {
    return {
      shouldRelease: false,
      version: null,
      tag: null,
      previousTag: highest.tag,
      headSha: headSha || null,
      reason: "本周没有新的合并",
      commits: [],
      pullRequests: [],
      notesMarkdown: "",
    };
  }

  const nextPatch = highest.patch === 0 ? 1 : highest.patch + 1;
  const version = `0.1.${nextPatch}`;
  const tag = `v0.1.${nextPatch}`;
  const notesMarkdown = formatReleaseNotesMarkdown({
    version,
    previousTag: highest.tag,
    commits,
    repository,
    schemaVersion,
    previousSchemaVersion,
    willUpgradeSchema,
    ciMode,
  });

  return {
    shouldRelease: true,
    version,
    tag,
    previousTag: highest.tag,
    headSha: headSha || null,
    reason: `自 ${highest.tag} 以来有 ${commits.length} 个新合并`,
    commits,
    pullRequests,
    notesMarkdown,
  };
}

export function readGitWeeklyReleaseInputs(cwd = process.cwd()) {
  const tagRes = spawnSync("git", ["tag", "--list", "v0.1.*"], { cwd, encoding: "utf8", windowsHide: true });
  const tags = tagRes.status === 0 && tagRes.stdout
    ? tagRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  const headRes = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
  const headSha = headRes.status === 0 && headRes.stdout ? headRes.stdout.trim() : "";

  const sorted = parseReleaseTags(tags);
  const highest = sorted[0] ?? null;
  const logArgs = highest
    ? ["log", `${highest.tag}..HEAD`, "--first-parent", "--pretty=format:%H%x09%s"]
    : ["log", "-n", "20", "--first-parent", "--pretty=format:%H%x09%s"];
  const logRes = spawnSync("git", logArgs, { cwd, encoding: "utf8", windowsHide: true });
  const commitsSinceTag = logRes.status === 0 && logRes.stdout
    ? logRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  return { tags, commitsSinceTag, headSha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputs = readGitWeeklyReleaseInputs(process.cwd());
  const decision = decideWeeklyRelease({
    ...inputs,
    repository: process.env.GITHUB_REPOSITORY || "chialecode/manga",
    ciMode: true,
  });

  if (process.env.GITHUB_OUTPUT) {
    const outLines = [
      `should_release=${decision.shouldRelease ? "true" : "false"}`,
      `version=${decision.version ?? ""}`,
      `tag=${decision.tag ?? ""}`,
      `previous_tag=${decision.previousTag ?? ""}`,
      `reason=${decision.reason}`,
    ];
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${outLines.join("\n")}\n`, "utf8");
  }

  console.log(JSON.stringify({
    check: "release-decide",
    shouldRelease: decision.shouldRelease,
    version: decision.version,
    tag: decision.tag,
    previousTag: decision.previousTag,
    reason: decision.reason,
    commitsCount: decision.commits.length,
    pullRequestsCount: decision.pullRequests.length,
  }));
}
