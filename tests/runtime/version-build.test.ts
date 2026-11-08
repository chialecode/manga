import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_JSON_NAME,
  BUILD_SCHEMA_VERSION,
  MangaProductApp,
  TestVault,
  VERSION_LINE,
  computeDevVersion,
  computeNextReleaseVersion,
  createBuildInfo,
  formatUtcBuildTimestamp,
  readBuildInfo,
  readBuildInfoIfPresent,
  readGitShortCommit,
  readGitTags,
  resolveBuildVersion,
  writeBuildInfo,
} from "@manga/app-core";
import { PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import semver from "semver";

const tempDirs: string[] = [];
const makeTemp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-version-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("versioning rules and build.json metadata (AT-157, 计划 4.1)", () => {
  it("computes 0.1.1 when no v0.1.* tag exists and highest + 1 when tags exist, even when non-contiguous", () => {
    expect(computeNextReleaseVersion([])).toBe("0.1.1");
    expect(computeNextReleaseVersion(["", "   "])).toBe("0.1.1");
    expect(computeNextReleaseVersion(["v0.1.0"])).toBe("0.1.1");
    expect(computeNextReleaseVersion(["v0.1.1"])).toBe("0.1.2");
    expect(computeNextReleaseVersion(["v0.1.1", "v0.1.3"])).toBe("0.1.4");
    expect(computeNextReleaseVersion(["0.1.2", "v0.1.7", "v0.1.4"])).toBe("0.1.8");
  });

  it("never auto-bumps to 0.2 or 1.0 and ignores non-0.1.* or pre-release tags", () => {
    expect(computeNextReleaseVersion(["v0.1.9"])).toBe("0.1.10");
    expect(computeNextReleaseVersion(["v0.1.99"])).toBe("0.1.100");
    expect(computeNextReleaseVersion(["v0.2.0", "v1.0.0", "v0.1.2-dev.202611081530", "v0.1.02", "release-1"])).toBe("0.1.1");
    expect(computeNextReleaseVersion(["v0.1.3", "v0.2.5", "v1.0.0", "v0.1.9-dev.202611081530"])).toBe("0.1.4");
  });

  it("formats development versions as <nextRelease>-dev.<YYYYMMDDHHmm> in UTC without a leading zero and orders monotonically", () => {
    const t1 = new Date("2026-11-08T05:07:09Z");
    const t2 = new Date("2026-11-08T15:30:45Z");
    const t3 = new Date("2026-11-09T00:01:00Z");
    expect(formatUtcBuildTimestamp(t1)).toBe("202611080507");
    expect(formatUtcBuildTimestamp(t2)).toBe("202611081530");
    expect(formatUtcBuildTimestamp(t1)).toMatch(/^[1-9]\d{11}$/);

    const v1 = computeDevVersion(["v0.1.1"], t1);
    const v2 = computeDevVersion(["v0.1.1"], t2);
    const v3 = computeDevVersion(["v0.1.2"], t3);
    expect(v1).toBe("0.1.2-dev.202611080507");
    expect(v2).toBe("0.1.2-dev.202611081530");
    expect(v3).toBe("0.1.3-dev.202611090001");
    expect(semver.lt(v1, v2)).toBe(true);
    expect(semver.lt(v2, v3)).toBe(true);
    expect(resolveBuildVersion("release", { tags: ["v0.1.2"] })).toBe("0.1.3");
    expect(resolveBuildVersion("development", { tags: ["v0.1.2"], date: t2 })).toBe("0.1.3-dev.202611081530");
  });

  it("keeps apps/desktop/package.json at the 0.1.0 version line and matches the storage schema version", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("apps/desktop/package.json"), "utf8")) as {
      version: string;
      description: string;
      author: string;
      homepage: string;
      copyright: string;
    };
    expect(pkg.version).toBe("0.1.0");
    expect(VERSION_LINE).toBe("0.1.0");
    expect(BUILD_SCHEMA_VERSION).toBe(PRODUCT_SCHEMA_VERSION);
    expect(pkg.description).toBe("二次元阅读观看、记录与辅助创作工作台");
    expect(pkg.author).toBe("chialecode");
    expect(pkg.homepage).toBe("https://github.com/chialecode/manga");
    expect(pkg.copyright).toBe("Copyright © 2026 chialecode");
  });

  it("round-trips build.json and exposes version and commit in MangaProductApp, settings, debug.context and agent.trace.export", async () => {
    const dir = makeTemp();
    const resourcesDir = path.join(dir, "resources");
    const builtAt = "2026-11-08T15:30:00.000Z";
    const info = createBuildInfo({
      channel: "release",
      tags: ["v0.1.2"],
      commit: "abc1234",
      builtAt,
    });
    expect(info).toEqual({
      version: "0.1.3",
      channel: "release",
      commit: "abc1234",
      builtAt,
      schemaVersion: PRODUCT_SCHEMA_VERSION,
    });
    writeBuildInfo(resourcesDir, info);
    expect(fs.existsSync(path.join(resourcesDir, BUILD_JSON_NAME))).toBe(true);
    expect(readBuildInfoIfPresent(resourcesDir)).toEqual(info);
    expect(readBuildInfo(resourcesDir)).toEqual(info);
    expect(readGitShortCommit()).toMatch(/^[0-9a-f]{7,}$/);
    expect(Array.isArray(readGitTags())).toBe(true);

    const profileRoot = path.join(dir, "profile");
    const app = new MangaProductApp({
      profileRoot,
      channel: "test",
      resourcesPath: resourcesDir,
      vault: new TestVault("v"),
    });
    await app.start();
    try {
      expect(app.appVersion).toBe("0.1.3");
      expect(app.buildInfo).toEqual({
        version: "0.1.3",
        channel: "test",
        commit: "abc1234",
        builtAt,
        schemaVersion: PRODUCT_SCHEMA_VERSION,
      });
      const actor = { kind: "user" as const, id: "u" };
      const owner = app.issueOwnerGrant(actor);
      const settings = await app.call(actor, { commandId: "settings.get", idempotencyKey: "s1", input: {} }, owner.handle);
      expect(settings.status).toBe("ok");
      expect(settings.value).toMatchObject({
        appVersion: "0.1.3",
        buildInfo: { version: "0.1.3", commit: "abc1234", builtAt, schemaVersion: PRODUCT_SCHEMA_VERSION },
      });
      const debug = await app.call(actor, { commandId: "debug.context", idempotencyKey: "d1", input: {} }, owner.handle);
      expect(debug.status).toBe("ok");
      expect(debug.value).toMatchObject({
        appVersion: "0.1.3",
        commit: "abc1234",
        buildInfo: { version: "0.1.3", commit: "abc1234" },
      });
      const exported = app.trace.export("run-empty");
      expect(JSON.parse(exported.json)).toMatchObject({
        runId: "run-empty",
        appVersion: "0.1.3",
        commit: "abc1234",
      });
    } finally {
      app.close();
    }
  });
});
