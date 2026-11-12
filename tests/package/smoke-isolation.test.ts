import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

const main = path.resolve(import.meta.dirname, "../../apps/desktop/src/main");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("test hooks stay out of a normal start", () => {
  const lightSmoke = path.join(main, "light", "smoke.ts");
  const outside = sources(main).filter((file) => !file.startsWith(path.join(main, "smoke")) && file !== lightSmoke);
  const smokeImport = /\bfrom\s+["']\.{1,2}\/(?:\.\.\/)*(?:main\/)?(?:light\/)?smoke(?:\/[^"']*|\.ts)?["']|\bimport\s+["'][^"']*\/smoke(?:\/|\.ts["'])/;

  it("no module outside the smoke directory imports it statically", () => {
    for (const file of outside) expect(fs.readFileSync(file, "utf8"), path.relative(main, file)).not.toMatch(smokeImport);
  });

  it("the entry points load smoke only with a dynamic import under the smoke flag", () => {
    for (const [entryFile, pattern] of [
      [path.join(main, "index.ts"), /import\(\s*["']\.\/smoke\/[^"']+["']\s*\)/g],
      [path.join(main, "light", "main.ts"), /import\(\s*["']\.\/smoke\.ts["']\s*\)/g],
    ] as const) {
      const text = fs.readFileSync(entryFile, "utf8");
      const loads = [...text.matchAll(pattern)];
      expect(loads, path.relative(main, entryFile)).toHaveLength(1);
      const before = text.slice(0, loads[0]!.index);
      expect(before.slice(before.lastIndexOf("if (")).startsWith("if (smoke)"), path.relative(main, entryFile)).toBe(true);
      expect(text, path.relative(main, entryFile)).toMatch(/const smoke = process\.argv\.includes\("--manga-smoke"\)/);
    }
  });

  it("the smoke modules are not reachable from the other main-process modules at all", () => {
    for (const file of outside) {
      const text = fs.readFileSync(file, "utf8");
      const mentions = [...text.matchAll(/["'](\.{1,2}\/[^"']*smoke[^"']*)["']/g)].map((match) => match[1]);
      const expected = file === path.join(main, "index.ts")
        ? ["./smoke/index.ts"]
        : file === path.join(main, "light", "main.ts")
          ? ["./smoke.ts"]
          : [];
      expect(mentions, path.relative(main, file)).toEqual(expected);
    }
  });

  it("conditional wait helper times out and returns false when a selector does not match (LOOP-29)", async () => {
    const { waitDrawn, waitUntil } = await import("../../apps/desktop/src/main/smoke/driver.ts");
    const fakeView = {
      webContents: {
        executeJavaScript: (code: string) => new Function("document", `return (${code});`)({ querySelector: () => null, querySelectorAll: () => [] }),
      },
    };
    const started = Date.now();
    const matched = await waitDrawn(fakeView as never, "broken-selector-for-timeout-check", 80);
    const elapsed = Date.now() - started;
    expect(matched).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(70);
    const ok = await waitUntil(fakeView as never, "1 + 1 === 2", 80);
    expect(ok).toBe(true);
  });

  it("waits for a lagging native fullscreen exit without clicking the button to enter it again", async () => {
    const { exitScreenFullscreen } = await import("../../apps/desktop/src/main/smoke/common.ts");
    let nativeFull = true;
    const events: Array<{ type: string }> = [];
    const view = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isFullScreen: () => nativeFull,
      webContents: {
        sendInputEvent: (event: { type: string }) => { events.push(event); },
        executeJavaScript: (code: string) => new Function("document", "requestAnimationFrame", `return (${code});`)(
          { fullscreenElement: null },
          (callback: () => void) => setTimeout(callback, 1),
        ),
      },
    });
    const restoring = exitScreenFullscreen(view as never, false, "video-fullscreen");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.listenerCount("leave-full-screen")).toBe(1);
    nativeFull = false;
    view.emit("leave-full-screen");
    expect(await restoring).toEqual({ left: true, restored: true, leftBy: "escape" });
    expect(events.map((event) => event.type)).toEqual(["keyDown", "keyUp"]);
    expect(view.listenerCount("leave-full-screen")).toBe(0);
  });

  it("fails a fullscreen wait that never reaches the native window and releases its listeners", async () => {
    const { waitWindowFullscreen } = await import("../../apps/desktop/src/main/smoke/driver.ts");
    const view = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFullScreen: () => true });
    expect(await waitWindowFullscreen(view as never, false, 50)).toBe(false);
    expect(view.listenerCount("leave-full-screen")).toBe(0);
    expect(view.listenerCount("closed")).toBe(0);
  });

  it("smoke windows mute audio, stay off the taskbar, and never call view.show()", () => {
    const entry = fs.readFileSync(path.join(main, "index.ts"), "utf8");
    expect(entry).toContain('app.commandLine.appendSwitch("mute-audio")');
    expect(entry).toContain("window.webContents.setAudioMuted(true)");
    expect(entry).toContain("skipTaskbar: hideWindow");
    const lightEntry = fs.readFileSync(path.join(main, "light", "main.ts"), "utf8");
    expect(lightEntry).toContain('app.commandLine.appendSwitch("mute-audio")');
    const smokeFiles = [...sources(path.join(main, "smoke")), lightSmoke];
    for (const file of smokeFiles) {
      expect(fs.readFileSync(file, "utf8"), path.relative(main, file)).not.toMatch(/\b(?:view|window)\.show\(\)/);
    }
  });
});
