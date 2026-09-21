import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { MangaError, createId } from "@manga/contracts";

export type DownloadPlan = {
  id: string;
  version: number;
  url: string;
  fileName: string;
  targetDir: string;
  quotaBytes: number;
  etag?: string;
};

export type DownloadState = {
  jobId: string;
  phase: "resolving" | "transferring" | "verifying" | "publishing" | "importing";
  artifact?: {
    stagingPath: string;
    targetPath?: string;
    fingerprint?: string;
    etag?: string;
    bytes?: number;
    publishState: string;
  };
  receipt?: { resourceId: string; revisionId: string; idempotencyKey: string };
};

const CRASH = process.env.M0_CRASH_AT;

function maybeCrash(stage: string): void {
  if (CRASH === stage) process.exit(99);
}

export function safeFileName(name: string): string {
  if (!name || name !== path.basename(name.replaceAll("\\", "/")) || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new MangaError("PATH_ESCAPE", "illegal file name");
  }
  return name;
}

export function volumeOf(target: string): string { return String(fs.statSync(fs.realpathSync(target)).dev); }
export function sameVolume(a: string, b: string): boolean { return volumeOf(a) === volumeOf(b); }

export async function publishAtomic(stagingPath: string, targetPath: string, injectDiskFull = false, prepared?: (identity:{dev:string;ino:string})=>void): Promise<void> {
  if (injectDiskFull) throw new MangaError("DISK_FULL", "injected ENOSPC");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  maybeCrash("after-verify-before-publish");
  const temporary = `${targetPath}.publish-${createId("tmp")}`;
  let source = stagingPath;
  try {
    if (!sameVolume(stagingPath, path.dirname(targetPath))) {
      fs.copyFileSync(stagingPath, temporary, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(temporary, "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fingerprintFile(temporary) !== fingerprintFile(stagingPath)) throw new Error("cross-volume copy checksum mismatch");
      source = temporary;
    }
    // Creating a hard link is an atomic no-replace operation. rename() can overwrite.
    const identity=fs.statSync(source,{bigint:true});
    prepared?.({dev:String(identity.dev),ino:String(identity.ino)});
    fs.linkSync(source, targetPath);
    maybeCrash("after-publish-before-record");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MangaError("PUBLISH_CONFLICT", "refusing to overwrite existing file");
    throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function fingerprintFile(file: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export async function downloadToStaging(plan: DownloadPlan, stagingPath: string, options: {
  headers?: Record<string, string>; previousEtag?: string; signal?: AbortSignal;
} = {}): Promise<{ bytes: number; etag?: string }> {
  safeFileName(plan.fileName);
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
  let current = new URL(plan.url);
  for (let i = 0; i <= 3; i++) {
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "download cancelled");
    if (current.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(current.hostname) || current.username || current.password) throw new MangaError("FORBIDDEN", "only the authorized loopback HTTP fixture is allowed");
    const result = await httpGet(current, options.headers ?? {}, plan.quotaBytes, options.signal);
    if (result.status >= 300 && result.status < 400 && result.headers.location) { current = new URL(result.headers.location, current); continue; }
    if (result.status !== 200) throw new MangaError("PROVIDER_UNAVAILABLE", `download HTTP ${result.status}; unsolicited partial body rejected`);
    const etag = result.headers.etag;
    if (options.previousEtag && options.previousEtag !== etag) throw new MangaError("ETAG_CHANGED", "remote version changed or validator missing; restart download");
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "download cancelled");
    const declared = Number(result.headers["content-length"] ?? result.body.length);
    if (!Number.isFinite(declared) || declared !== result.body.length) throw new MangaError("VALIDATION_ERROR", "content-length mismatch");
    const fd = fs.openSync(stagingPath, "w");
    try { fs.writeFileSync(fd, result.body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { bytes: result.body.length, etag };
  }
  throw new MangaError("PROVIDER_UNAVAILABLE", "too many redirects");
}

function httpGet(url: URL, headers: Record<string, string>, quota: number, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 3000, signal }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("incomplete HTTP body")));
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > quota) { const error = new MangaError("QUOTA_EXCEEDED", "download exceeded quota"); reject(error); res.destroy(error); req.destroy(error); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) normalized[key] = Array.isArray(value) ? value.join(",") : value;
        resolve({ status: res.statusCode ?? 0, headers: normalized, body: Buffer.concat(chunks) });
      });
    });
    req.on("timeout", () => req.destroy(new Error("download timeout")));
    req.on("error", reject);
  });
}

export function startLoopbackServer(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const files = new Map<string, { body: Buffer; etag: string; slow?: number; wrongLength?: boolean }>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/redirect-private") {
      res.writeHead(302, { Location: "http://10.0.0.1/secret" });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-ok") {
      res.writeHead(302, { Location: "/files/ok.bin" });
      res.end();
      return;
    }
    const key = url.pathname.replace(/^\/files\//, "");
    const file = files.get(key) ?? files.get(url.pathname);
    if (!file) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const range = req.headers.range;
    const send = (status: number, body: Buffer, extra: Record<string, string> = {}) => {
      const headers: Record<string, string | number> = {
        ETag: file.etag,
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        ...extra,
      };
      if (file.wrongLength) headers["Content-Length"] = body.length + 12;
      else headers["Content-Length"] = body.length;
      res.writeHead(status, headers);
      if (file.slow) {
        setTimeout(() => res.end(body), file.slow);
      } else res.end(body);
    };
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : file.body.length - 1;
        send(206, file.body.subarray(start, end + 1), {
          "Content-Range": `bytes ${start}-${end}/${file.body.length}`,
        });
        return;
      }
    }
    send(200, file.body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("bind failed");
      const dir = fs.readdirSync(root);
      for (const name of dir) {
        const body = fs.readFileSync(path.join(root, name));
        files.set(name, { body, etag: `"${crypto.createHash("sha1").update(body).digest("hex")}"` });
      }
      files.set("slow.bin", { body: Buffer.from("SLOW"), etag: '"slow"', slow: 30 });
      files.set("wrong-length.bin", { body: Buffer.from("LEN"), etag: '"len"', wrongLength: true });
      files.set("ok.bin", { body: Buffer.from("OKFILE"), etag: '"ok"' });
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
