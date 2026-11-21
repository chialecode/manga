import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBlockMap,
  formatLatestYaml,
  parseBlockMapBytes,
  rawPublicKey,
  serializeBlockMapGzip,
  sha512BytesBase64,
  signReleaseInstaller,
} from "../../packages/app-core/src/update/signature.ts";
import { startApp } from "../helpers/app.ts";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function makeKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeys: [{ publicKey: rawPublicKey(publicKey).toString("base64"), label: "Test Key" }],
  };
}

describe("update service & signature hardening (F-04, F-22)", () => {
  it("rejects gzip bombs in parseBlockMapBytes (F-22)", () => {
    const hugeZeros = Buffer.alloc(40 * 1024 * 1024, 0x20);
    const bomb = zlib.gzipSync(hugeZeros);
    expect(() => parseBlockMapBytes(bomb)).toThrow();
  });

  it("restores rollback cache when runInstaller fails so a retry preserves previous/, and handles duplicate restartToUpdate (F-04, F-22)", async () => {
    const keys = makeKeyPair();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-upd-f04-"));
    closers.push(() => fs.rmSync(tmp, { recursive: true, force: true }));

    const oldBytes = randomBytes(65536 * 2);
    const newBytes = Buffer.concat([oldBytes.subarray(0, 65536), randomBytes(65536)]);
    const fileName = "manga-setup-1.1.0.exe";
    const newExePath = path.join(tmp, fileName);
    fs.writeFileSync(newExePath, newBytes);
    const signed = signReleaseInstaller({ installerPath: newExePath, version: "1.1.0", fileName, privateKeyPem: keys.privateKeyPem });
    const latestYml = formatLatestYaml({ version: "1.1.0", fileName, sha512: sha512BytesBase64(newBytes), size: newBytes.length });
    const oldBlockMapGz = serializeBlockMapGzip(buildBlockMap(oldBytes));
    const newBlockMapGz = serializeBlockMapGzip(buildBlockMap(newBytes));

    const files = new Map<string, Buffer | string>([
      ["latest.yml", latestYml],
      [fileName, newBytes],
      [`${fileName}.sig`, signed.sigText],
      [`${fileName}.blockmap`, newBlockMapGz],
    ]);
    const server = http.createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+/, "");
      const item = files.get(key);
      if (item === undefined) { res.writeHead(404); res.end(); return; }
      const buf = typeof item === "string" ? Buffer.from(item, "utf8") : item;
      const range = typeof req.headers.range === "string" ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null;
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : buf.length - 1;
        const slice = buf.subarray(start, end + 1);
        res.writeHead(206, { "content-range": `bytes ${start}-${end}/${buf.length}`, "content-length": String(slice.length) });
        res.end(slice);
        return;
      }
      res.writeHead(200, { "content-length": String(buf.length) });
      res.end(buf);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    closers.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }));
    const port = (server.address() as { port: number }).port;

    const ctx = await startApp();
    closers.push(() => ctx.app.close());

    let allowInstall = false;
    let holdInstall: (() => void) | null = null;
    ctx.app.update.configure({
      buildInfo: { version: "1.0.0", channel: "release", commit: "abc", builtAt: "2026-01-01T00:00:00.000Z", schemaVersion: 17 },
      feedUrl: `http://127.0.0.1:${port}`,
      allowLoopbackHttp: true,
      requireAppUpdateConfig: false,
      publicKeys: keys.publicKeys,
      runInstaller: async () => {
        if (!allowInstall) return false;
        await new Promise<void>((resolve) => { holdInstall = resolve; });
        return true;
      },
      resetState: true,
    });
    ctx.app.update.seedCurrentInstallerCache(oldBytes, oldBlockMapGz);

    const status = await ctx.app.update.check({ manual: true, download: true });
    expect(status.state).toBe("ready");
    expect(status.usedDifferential).toBe(true);

    const cacheDir = path.join(ctx.app.layout.partitions.cache, "updater");
    const previousDir = path.join(cacheDir, "previous");
    const installerJsonPath = path.join(cacheDir, "installer.json");

    // Attempt 1: runInstaller returns false -> rollback cache MUST be restored to 1.0.0 and previous/ removed.
    await expect(ctx.app.update.restartToUpdate({ force: true })).rejects.toMatchObject({ code: "UPDATE_UNAVAILABLE" });
    expect(JSON.parse(fs.readFileSync(installerJsonPath, "utf8"))).toMatchObject({ version: "1.0.0" });
    expect(fs.readFileSync(path.join(cacheDir, "installer.exe")).equals(oldBytes)).toBe(true);
    expect(fs.existsSync(previousDir)).toBe(false);

    // Attempt 2: runInstaller succeeds (held briefly to test idempotent double-click).
    allowInstall = true;
    const pFirst = ctx.app.update.restartToUpdate({ force: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await ctx.app.update.restartToUpdate({ force: true });
    expect(second).toMatchObject({ status: "restarting", restarted: true, version: "1.1.0" });
    holdInstall?.();
    const first = await pFirst;
    expect(first).toMatchObject({ status: "restarting", restarted: true, version: "1.1.0" });

    // Previous version 1.0.0 was preserved cleanly into previous/!
    const prevMeta = JSON.parse(fs.readFileSync(path.join(previousDir, "previous.json"), "utf8")) as { version: string; targetVersion: string };
    expect(prevMeta).toMatchObject({ version: "1.0.0", targetVersion: "1.1.0" });
  });
});
