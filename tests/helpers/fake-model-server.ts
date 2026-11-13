import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AsrCatalogModel } from "../../packages/app-core/src/voice/models/catalog.ts";
import { resolveSystemTarExe } from "../../packages/app-core/src/voice/models/tar-extract.ts";

export type RawUstarEntry = {
  name: string;
  typeflag?: "0" | "1" | "2" | "5";
  linkname?: string;
  body?: Buffer | string;
  mode?: number;
};

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function writeOctalField(header: Buffer, value: number, offset: number, length: number): void {
  const octal = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0");
  header.write(octal.slice(-(length - 1)), offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

export function createUstarArchiveBuffer(entries: readonly RawUstarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const typeflag = entry.typeflag ?? "0";
    const bodyBuf =
      typeflag === "0"
        ? typeof entry.body === "string"
          ? Buffer.from(entry.body, "utf8")
          : (entry.body ?? Buffer.alloc(0))
        : Buffer.alloc(0);

    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, Math.min(100, Buffer.byteLength(entry.name, "utf8")), "utf8");
    writeOctalField(header, entry.mode ?? (typeflag === "5" ? 0o755 : 0o644), 100, 8);
    writeOctalField(header, 0, 108, 8);
    writeOctalField(header, 0, 116, 8);
    writeOctalField(header, bodyBuf.length, 124, 12);
    writeOctalField(header, 1_700_000_000, 136, 12);
    header.fill(0x20, 148, 156); // checksum placeholder spaces
    header.write(typeflag, 156, 1, "ascii");
    if (entry.linkname) {
      header.write(entry.linkname, 157, Math.min(100, Buffer.byteLength(entry.linkname, "utf8")), "utf8");
    }
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");

    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i]!;
    const chk = sum.toString(8).padStart(6, "0");
    header.write(chk, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;

    blocks.push(header);
    if (bodyBuf.length > 0) {
      blocks.push(bodyBuf);
      const rem = bodyBuf.length % 512;
      if (rem > 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/**
 * Wraps raw `ustar` entries (including symlinks, hardlinks, `..` traversal, `C:` drive paths, or spoofed sizes)
 * into a `.tar.bz2` file using `System32\tar.exe -cjf out.tar.bz2 @raw.tar` (or bzip2 stream) without needing
 * elevated symlink privileges on Windows.
 */
export function buildHostileTarBz2(
  workDir: string,
  fileName: string,
  entries: readonly RawUstarEntry[],
): {
  archivePath: string;
  archiveBuffer: Buffer;
  archiveBytes: number;
  archiveSha256: string;
} {
  fs.mkdirSync(workDir, { recursive: true });
  const rawTarPath = path.join(workDir, `${fileName}.raw.tar`);
  const outBz2Path = path.join(workDir, fileName);
  const rawTar = createUstarArchiveBuffer(entries);
  fs.writeFileSync(rawTarPath, rawTar);

  const tarExe = resolveSystemTarExe();
  try {
    execFileSync(tarExe, ["-P", "-cjf", outBz2Path, `@${rawTarPath}`], {
      windowsHide: true,
      stdio: "pipe",
    });
  } finally {
    fs.rmSync(rawTarPath, { force: true });
  }

  const archiveBuffer = fs.readFileSync(outBz2Path);
  return {
    archivePath: outBz2Path,
    archiveBuffer,
    archiveBytes: archiveBuffer.length,
    archiveSha256: sha256Hex(archiveBuffer),
  };
}

export type SyntheticModelFixture = {
  modelId: string;
  topLevelDirectory: string;
  extractedDir: string;
  archivePath: string;
  archiveBuffer: Buffer;
  catalogModel: AsrCatalogModel;
  modelWeightsBytes: Buffer;
  tokensBytes: Buffer;
};

export function createSyntheticModelFixture(
  workDir: string,
  options: {
    modelId?: string;
    kind?: "qwen3Asr" | "senseVoice" | "funasrNano";
    sourceUrl?: string;
    weightsByteLength?: number;
  } = {},
): SyntheticModelFixture {
  const modelId = options.modelId ?? "synthetic-sense-voice-int8";
  const kind = options.kind ?? "senseVoice";
  const topLevelDirectory = `sherpa-onnx-${modelId}-2026-03-25`;
  const buildRoot = path.join(workDir, `fixture-${modelId}`);
  const extractedDir = path.join(buildRoot, topLevelDirectory);
  fs.mkdirSync(extractedDir, { recursive: true });

  const weightsLen = options.weightsByteLength ?? 48 * 1024;
  // High-entropy deterministic bytes so `bzip2` produces an archive close to `weightsLen` for multi-chunk Range streaming.
  const modelWeightsBytes = crypto.scryptSync("synthetic-asr-weights", modelId, weightsLen);
  const tokensBytes = Buffer.from("<blk> 0\n<sos> 1\n<eos> 2\n星 3\n野 4\n澪 5\n", "utf8");

  const modelFile = path.join(extractedDir, "model.int8.onnx");
  const tokensFile = path.join(extractedDir, "tokens.txt");
  fs.writeFileSync(modelFile, modelWeightsBytes);
  fs.writeFileSync(tokensFile, tokensBytes);

  const archiveName = `${topLevelDirectory}.tar.bz2`;
  const archivePath = path.join(workDir, archiveName);
  const tarExe = resolveSystemTarExe();
  execFileSync(tarExe, ["-cjf", archivePath, "-C", buildRoot, topLevelDirectory], {
    windowsHide: true,
    stdio: "pipe",
  });

  const archiveBuffer = fs.readFileSync(archivePath);
  const catalogModel: AsrCatalogModel = {
    id: modelId,
    modelId,
    name: `Synthetic ${modelId}`,
    kind,
    recommended: true,
    license: "Apache-2.0",
    licenseUrl: "https://github.com/k2-fsa/sherpa-onnx",
    upstreamDocsUrl: "https://k2-fsa.github.io/sherpa/onnx/index.html",
    languages: ["zh", "en", "ja", "auto"],
    hotwords: kind === "senseVoice" ? 0 : 50,
    archiveName,
    archiveBytes: archiveBuffer.length,
    archiveSha256: sha256Hex(archiveBuffer),
    topLevelDirectory,
    sources: [
      {
        id: "github",
        label: "GitHub Releases",
        url: options.sourceUrl ?? `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${archiveName}`,
      },
    ],
    requiredFiles: [
      {
        path: "model.int8.onnx",
        byteSize: modelWeightsBytes.length,
        sha256: sha256Hex(modelWeightsBytes),
        configRole: "model",
      },
      {
        path: "tokens.txt",
        byteSize: tokensBytes.length,
        sha256: sha256Hex(tokensBytes),
        configRole: "tokens",
      },
    ],
  };

  return {
    modelId,
    topLevelDirectory,
    extractedDir,
    archivePath,
    archiveBuffer,
    catalogModel,
    modelWeightsBytes,
    tokensBytes,
  };
}

export type RecordedDownloadRequest = {
  method: string;
  url: string;
  range: string | null;
  headers: http.IncomingHttpHeaders;
};

export type FakeServerRouteBehavior = {
  payload?: Buffer;
  etag?: string | null;
  statusCode?: number;
  ignoreRange?: boolean;
  /** Destroy socket after writing this many bytes (decrements `disconnectTimes` when set). */
  disconnectAfterBytes?: number;
  disconnectTimes?: number;
  chunkBytes?: number;
  chunkDelayMs?: number;
  /** Flip one byte at this offset in the served buffer to simulate corruption in transit. */
  tamperOffset?: number;
  redirectTo?: string;
};

export type FakeModelServer = {
  baseUrl: string;
  requests: RecordedDownloadRequest[];
  setRoute(routePath: string, behavior: FakeServerRouteBehavior): void;
  clearRequests(): void;
  close(): Promise<void>;
};

export async function startFakeModelServer(
  initialRoutes: Record<string, FakeServerRouteBehavior> = {},
): Promise<FakeModelServer> {
  const routes = new Map<string, FakeServerRouteBehavior>(Object.entries(initialRoutes));
  const requests: RecordedDownloadRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      range: typeof req.headers.range === "string" ? req.headers.range : null,
      headers: req.headers,
    });

    const route = routes.get(pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (route.redirectTo) {
      res.writeHead(route.statusCode ?? 302, { location: route.redirectTo });
      res.end();
      return;
    }

    if (route.statusCode && route.statusCode >= 400) {
      res.writeHead(route.statusCode, { "content-type": "text/plain" });
      res.end(`http error ${route.statusCode}`);
      return;
    }

    let sourceBuf = route.payload ?? Buffer.alloc(0);
    if (route.tamperOffset !== undefined && route.tamperOffset >= 0 && route.tamperOffset < sourceBuf.length) {
      sourceBuf = Buffer.from(sourceBuf);
      sourceBuf[route.tamperOffset] = sourceBuf[route.tamperOffset]! ^ 0xff;
    }

    const etagHeader = route.etag !== undefined ? route.etag : '"etag-v1"';
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : null;

    let start = 0;
    let status = 200;
    const headers: Record<string, string> = {
      "accept-ranges": "bytes",
      "content-type": "application/octet-stream",
    };
    if (etagHeader) {
      headers.etag = etagHeader;
    }

    if (rangeHeader && !route.ignoreRange) {
      const m = /^bytes=(\d+)-$/i.exec(rangeHeader.trim());
      if (m) {
        const requestedStart = Number(m[1]);
        if (requestedStart >= sourceBuf.length) {
          res.writeHead(416, { "content-range": `bytes */${sourceBuf.length}` });
          res.end();
          return;
        }
        start = requestedStart;
        status = 206;
        headers["content-range"] = `bytes ${start}-${sourceBuf.length - 1}/${sourceBuf.length}`;
      }
    }

    const slice = sourceBuf.subarray(start);
    headers["content-length"] = String(slice.length);
    res.writeHead(status, headers);

    const shouldDisconnect =
      route.disconnectAfterBytes !== undefined &&
      (route.disconnectTimes === undefined || route.disconnectTimes > 0);
    if (shouldDisconnect && route.disconnectTimes !== undefined) {
      route.disconnectTimes -= 1;
    }

    const chunkSize = Math.max(256, route.chunkBytes ?? 8 * 1024);
    const delayMs = route.chunkDelayMs ?? 0;
    let sent = 0;

    for (let pos = 0; pos < slice.length; pos += chunkSize) {
      if (req.destroyed || res.destroyed) return;
      if (shouldDisconnect && route.disconnectAfterBytes !== undefined && sent >= route.disconnectAfterBytes) {
        res.socket?.destroy();
        return;
      }
      const maxEnd =
        shouldDisconnect && route.disconnectAfterBytes !== undefined
          ? Math.min(slice.length, pos + chunkSize, route.disconnectAfterBytes)
          : Math.min(slice.length, pos + chunkSize);
      const chunk = slice.subarray(pos, maxEnd);
      await new Promise<void>((resolve) => {
        res.write(chunk, () => resolve());
      });
      sent += chunk.length;

      if (shouldDisconnect && route.disconnectAfterBytes !== undefined && sent >= route.disconnectAfterBytes) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        res.socket?.destroy();
        return;
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    if (!res.destroyed) {
      res.end();
    }
  });

  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });

  return new Promise<FakeModelServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        setRoute(routePath, behavior) {
          routes.set(routePath, behavior);
        },
        clearRequests() {
          requests.length = 0;
        },
        close() {
          for (const sock of sockets) {
            sock.destroy();
          }
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}
