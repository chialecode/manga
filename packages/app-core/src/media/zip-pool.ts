import fs from "node:fs";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import { MangaError } from "@manga/contracts";

export type ZipEntryInfo = {
  /** Name as stored, with backslashes turned into slashes. Only safe names are ever served. */
  name: string;
  uncompressedSize: number;
  compressedSize: number;
  directory: boolean;
  encrypted: boolean;
  /** Why the name cannot be used (absolute, parent segment, control characters), or null. */
  unsafe: string | null;
};

export type ZipIndex = {
  path: string;
  size: number;
  mtimeMs: number;
  entries: ZipEntryInfo[];
  byName: Map<string, ZipEntryInfo>;
};

export type ZipBudget = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Uncompressed/compressed ratio above which an entry larger than `ratioFloorBytes` is refused. */
  maxRatio: number;
  ratioFloorBytes: number;
};

export const CBZ_BUDGET: ZipBudget = {
  maxEntries: 20_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
  maxRatio: 150,
  ratioFloorBytes: 8 * 1024 * 1024,
};

/** Reason a stored name must not be used, or null when it is a plain relative path. */
export function unsafeEntryName(rawName: string): string | null {
  if (!rawName) return "empty name";
  if (rawName.length > 2048) return "name too long";
  if (/[\u0000-\u001f\u007f]/.test(rawName)) return "control character";
  const name = rawName.replace(/\\/g, "/");
  if (name.startsWith("/")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "drive letter";
  if (name.split("/").some((segment) => segment === "..")) return "parent segment";
  return null;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const LEGACY = (() => { try { return new TextDecoder("gb18030"); } catch { return new TextDecoder("latin1"); } })();

/**
 * Names are decoded here rather than by the reader, which would refuse an archive outright for a hostile name. A
 * name without the UTF-8 flag that is not valid UTF-8 is read as GB18030, the usual encoding of archives made on Chinese systems.
 */
function decodeName(raw: Buffer | string): string {
  if (typeof raw === "string") return raw;
  try { return UTF8.decode(raw); } catch { return LEGACY.decode(raw); }
}

type Open = { zip: yauzl.ZipFile; index: ZipIndex; raw: Map<string, yauzl.Entry>; lastUsed: number };

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false, decodeStrings: false }, (error, zip) => {
      if (error || !zip) reject(new MangaError("UNSUPPORTED_FORMAT", `archive cannot be opened: ${error?.message ?? "unknown"}`));
      else resolve(zip);
    });
  });
}

function readIndex(zip: yauzl.ZipFile, budget: ZipBudget, signal?: AbortSignal): Promise<{ entries: ZipEntryInfo[]; raw: Map<string, yauzl.Entry> }> {
  return new Promise((resolve, reject) => {
    if (zip.entryCount > budget.maxEntries) {
      reject(new MangaError("UNSUPPORTED_FORMAT", `archive has ${zip.entryCount} entries, more than the ${budget.maxEntries} allowed`));
      return;
    }
    if (signal?.aborted) {
      reject(new MangaError("CANCELLED", "archive read was cancelled"));
      return;
    }
    const entries: ZipEntryInfo[] = [];
    const raw = new Map<string, yauzl.Entry>();
    let total = 0;
    const onAbort = () => reject(new MangaError("CANCELLED", "archive read was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (error?: Error) => {
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve({ entries, raw });
    };
    zip.on("error", (error) => done(new MangaError("UNSUPPORTED_FORMAT", `archive is damaged: ${error.message}`)));
    zip.on("end", () => done());
    zip.on("entry", (entry: yauzl.Entry) => {
      try { handleEntry(entry); } catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
    });
    const handleEntry = (entry: yauzl.Entry) => {
      if (signal?.aborted) { done(new MangaError("CANCELLED", "archive read was cancelled")); return; }
      const fileName = decodeName(entry.fileName as unknown as Buffer | string);
      const directory = fileName.endsWith("/") || fileName.endsWith("\\");
      const unsafe = unsafeEntryName(fileName);
      const encrypted = entry.isEncrypted();
      total += entry.uncompressedSize;
      if (!directory && entry.uncompressedSize > budget.maxEntryBytes) {
        done(new MangaError("UNSUPPORTED_FORMAT", "an archive entry is larger than the per-entry budget"));
        return;
      }
      if (total > budget.maxTotalBytes) {
        done(new MangaError("UNSUPPORTED_FORMAT", "archive expands beyond the total budget"));
        return;
      }
      if (!directory && entry.uncompressedSize > budget.ratioFloorBytes && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > budget.maxRatio) {
        done(new MangaError("UNSUPPORTED_FORMAT", "an archive entry compresses implausibly well and is refused as an expansion bomb"));
        return;
      }
      const name = fileName.replace(/\\/g, "/");
      raw.set(name, entry);
      entries.push({
        name,
        uncompressedSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        directory,
        encrypted,
        unsafe,
      });
      zip.readEntry();
    };
    zip.readEntry();
  });
}

/**
 * Random access to ZIP members without loading the archive. A handful of archives stay open so paging through a book
 * does not re-read its central directory on every page; an archive that changed on disk is reopened.
 */
export class ZipPool {
  private readonly open = new Map<string, Open>();
  private readonly opening = new Map<string, Promise<Open>>();
  private closed = false;

  private readonly maxOpen: number;
  private readonly budget: ZipBudget;

  constructor(maxOpen = 6, budget: ZipBudget = CBZ_BUDGET) {
    this.maxOpen = maxOpen;
    this.budget = budget;
  }

  private async acquire(file: string, signal?: AbortSignal): Promise<Open> {
    if (this.closed) throw new MangaError("CANCELLED", "archive pool is closed");
    const stat = fs.statSync(file);
    const known = this.open.get(file);
    if (known && known.index.size === stat.size && known.index.mtimeMs === stat.mtimeMs) {
      known.lastUsed = Date.now();
      return known;
    }
    if (known) this.drop(file);
    const pending = this.opening.get(file);
    if (pending) return pending;
    const promise = (async () => {
      const zip = await openZip(file);
      try {
        const { entries, raw } = await readIndex(zip, this.budget, signal);
        const index: ZipIndex = { path: file, size: stat.size, mtimeMs: stat.mtimeMs, entries, byName: new Map(entries.map((entry) => [entry.name, entry])) };
        const record: Open = { zip, index, raw, lastUsed: Date.now() };
        this.open.set(file, record);
        this.trim();
        return record;
      } catch (error) {
        zip.close();
        throw error;
      }
    })().finally(() => this.opening.delete(file));
    this.opening.set(file, promise);
    return promise;
  }

  private drop(file: string): void {
    const record = this.open.get(file);
    if (!record) return;
    this.open.delete(file);
    try { record.zip.close(); } catch { /* already closed */ }
  }

  private trim(): void {
    while (this.open.size > this.maxOpen) {
      let oldest: string | undefined;
      let at = Infinity;
      for (const [file, record] of this.open) if (record.lastUsed < at) { at = record.lastUsed; oldest = file; }
      if (!oldest) break;
      this.drop(oldest);
    }
  }

  async index(file: string, signal?: AbortSignal): Promise<ZipIndex> {
    return (await this.acquire(file, signal)).index;
  }

  /** Stream one member. A member that is encrypted, unsafe or missing is refused with a typed error. */
  async openStream(file: string, name: string, signal?: AbortSignal): Promise<{ stream: Readable; info: ZipEntryInfo }> {
    const record = await this.acquire(file, signal);
    const info = record.index.byName.get(name);
    if (!info || info.directory) throw new MangaError("NOT_FOUND", "archive entry is missing");
    if (info.encrypted) throw new MangaError("UNSUPPORTED_FORMAT", "archive entry is encrypted");
    if (info.unsafe) throw new MangaError("FORBIDDEN", `archive entry name is unsafe: ${info.unsafe}`);
    const entry = record.raw.get(name);
    if (!entry) throw new MangaError("NOT_FOUND", "archive entry is missing");
    const stream = await new Promise<Readable>((resolve, reject) => {
      record.zip.openReadStream(entry, (error, readable) => {
        if (error || !readable) reject(new MangaError("UNSUPPORTED_FORMAT", `archive entry cannot be read: ${error?.message ?? "unknown"}`));
        else resolve(readable);
      });
    });
    if (signal) {
      if (signal.aborted) stream.destroy();
      else signal.addEventListener("abort", () => stream.destroy(), { once: true });
    }
    return { stream, info };
  }

  async read(file: string, name: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
    const { stream, info } = await this.openStream(file, name, options.signal);
    const limit = Math.min(options.maxBytes ?? this.budget.maxEntryBytes, this.budget.maxEntryBytes);
    if (info.uncompressedSize > limit) {
      stream.destroy();
      throw new MangaError("UNSUPPORTED_FORMAT", "archive entry exceeds the read budget");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > limit) { stream.destroy(); throw new MangaError("UNSUPPORTED_FORMAT", "archive entry exceeds the read budget"); }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }

  close(): void {
    this.closed = true;
    for (const file of [...this.open.keys()]) this.drop(file);
  }
}
