import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => "0.0.0" },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn(), removeListener: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

import { stashComposerAttachment } from "../../apps/desktop/src/main/ipc-handlers.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("stashComposerAttachment", () => {
  it("stages valid attachments in the cache partition, registers a pathHandle, and rejects unsafe or invalid inputs", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-stash-"));
    tempDirs.push(cacheDir);
    const registered = new Map<string, string>();
    const tracked = new Set<string>();
    const registerPath = (_purpose: "file", resolvedPath: string) => {
      const handle = `handle-${registered.size + 1}`;
      registered.set(handle, resolvedPath);
      return handle;
    };

    const ok = stashComposerAttachment(
      { name: "../dir/report.pdf", mimeType: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
      cacheDir,
      registerPath,
      tracked,
    );
    expect(ok).toEqual({ pathHandle: "handle-1", name: "report.pdf", mimeType: "application/pdf" });
    const stagedPath = registered.get("handle-1")!;
    expect(stagedPath.startsWith(path.join(cacheDir, "composer-attachments"))).toBe(true);
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(tracked.has(stagedPath)).toBe(true);

    // Rejects blocked executable extensions, empty payloads, and malformed objects.
    expect(stashComposerAttachment({ name: "payload.exe", bytes: new Uint8Array([1, 2, 3]) }, cacheDir, registerPath, tracked)).toBeNull();
    expect(stashComposerAttachment({ name: "script.ps1", bytes: new Uint8Array([1, 2, 3]) }, cacheDir, registerPath, tracked)).toBeNull();
    expect(stashComposerAttachment({ name: "empty.txt", bytes: new Uint8Array(0) }, cacheDir, registerPath, tracked)).toBeNull();
    expect(stashComposerAttachment({ name: "   ", bytes: new Uint8Array([1]) }, cacheDir, registerPath, tracked)).toBeNull();
    expect(stashComposerAttachment(null, cacheDir, registerPath, tracked)).toBeNull();
  });
});
