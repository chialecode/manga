import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build, createLogger, type InlineConfig, type LogOptions } from "vite";
import { danmakuCredentialsFor, danmakuDefine } from "../../apps/desktop/danmaku-define.ts";
import { mainBuild } from "../../apps/desktop/vite.main.config.ts";
import rendererConfig from "../../apps/desktop/vite.renderer.config.ts";

const appRoot = path.resolve(process.cwd(), "apps/desktop");
/** Not real: shaped like a real pair (ten and thirty-two characters) and made to be easy to search for. */
const FAKE = { id: "ZZfakeid01", secret: "ZZfakesecretZZfakesecretZZfake00" };

const folders: string[] = [];
const scratch = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-leak-${name}-`));
  folders.push(dir);
  return dir;
};
afterAll(() => { for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true }); });

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
}
const contains = (dir: string, needle: string) => filesIn(dir).filter((file) => fs.readFileSync(file).includes(Buffer.from(needle)));

describe("the credentials a release is built with (AT-94)", () => {
  it("come from the environment first, then from the root's .env.local, and only the two names are ever read from the file", () => {
    const root = scratch("env");
    fs.writeFileSync(path.join(root, ".env.local"), [
      "# a comment",
      "MANGA_DANDANPLAY_APP_ID=\"fromfile01\"",
      "MANGA_DANDANPLAY_APP_SECRET=fromfilesecret0001",
      `MANGA_TEST_LIBRARY_NOVEL=${["D:", "private", "novels"].join("\\")}`,
      "SOMETHING_ELSE=do-not-read-me",
    ].join("\n"));
    expect(danmakuCredentialsFor({}, root)).toEqual({ appId: "fromfile01", secret: "fromfilesecret0001" });
    expect(danmakuCredentialsFor({ MANGA_DANDANPLAY_APP_ID: "fromenv001", MANGA_DANDANPLAY_APP_SECRET: "fromenvsecret0002" }, root)).toEqual({ appId: "fromenv001", secret: "fromenvsecret0002" });
    const define = danmakuDefine({}, root);
    expect(Object.keys(define).sort()).toEqual(["__MANGA_DANDANPLAY_APP_ID__", "__MANGA_DANDANPLAY_APP_SECRET__"]);
    expect(JSON.stringify(define)).not.toMatch(/private|do-not-read-me/);
  });

  it("are dropped whole when one of them is missing or has an odd shape, and the build then has none", () => {
    const root = scratch("shape");
    expect(danmakuCredentialsFor({ MANGA_DANDANPLAY_APP_ID: "onlyanid01" }, root)).toBeNull();
    expect(danmakuCredentialsFor({ MANGA_DANDANPLAY_APP_ID: "has space", MANGA_DANDANPLAY_APP_SECRET: "fine-secret-value" }, root)).toBeNull();
    expect(danmakuCredentialsFor({ MANGA_DANDANPLAY_APP_ID: "ok-id-0001", MANGA_DANDANPLAY_APP_SECRET: "quote\"inside" }, root)).toBeNull();
    expect(danmakuDefine({}, root)).toEqual({ __MANGA_DANDANPLAY_APP_ID__: "\"\"", __MANGA_DANDANPLAY_APP_SECRET__: "\"\"" });
  });
});

describe("a build with credentials puts them in the main process and nowhere the screen can read (AT-94)", () => {
  const out = { main: "", renderer: "", preload: "" };
  const log: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("MANGA_DANDANPLAY_APP_ID", FAKE.id);
    vi.stubEnv("MANGA_DANDANPLAY_APP_SECRET", FAKE.secret);
    out.main = scratch("main");
    out.renderer = scratch("renderer");
    out.preload = scratch("preload");
    const logger = createLogger("info", { allowClearScreen: false });
    const capture = (kind: "info" | "warn" | "error") => (message: string, options?: LogOptions) => { log.push(message); logger[kind](message, options); };
    const customLogger = { ...logger, info: capture("info"), warn: capture("warn"), error: capture("error"), warnOnce: capture("warn") };
    const common: InlineConfig = { configFile: false, customLogger, logLevel: "info" };
    // The main process, as the release builds it: the define comes from the environment the build runs in.
    await build({ ...common, ...mainBuild, define: danmakuDefine(process.env, scratch("none")), root: appRoot, build: { ...mainBuild.build, outDir: out.main, emptyOutDir: true, sourcemap: true } });
    // The screen and the preload bridge, with the same variables in the environment: their configs do not read them.
    await build({ ...common, ...rendererConfig, root: path.join(appRoot, "src/renderer"), build: { ...rendererConfig.build, outDir: out.renderer, emptyOutDir: true, sourcemap: true } });
    await build({
      ...common, root: appRoot,
      build: { lib: { entry: "src/preload/preload.ts", formats: ["cjs"], fileName: () => "preload.cjs" }, rollupOptions: { external: ["electron"] }, outDir: out.preload, emptyOutDir: true, sourcemap: true },
    });
  }, 300_000);

  it("finds them in the main bundle, as the positive control, and in no file of the screen or the preload bridge", () => {
    expect(contains(out.main, FAKE.secret).map((file) => path.basename(file))).toContain("main.cjs");
    expect(contains(out.main, FAKE.id).map((file) => path.basename(file))).toContain("main.cjs");
    for (const dir of [out.renderer, out.preload]) {
      expect(filesIn(dir).length).toBeGreaterThan(0);
      expect(contains(dir, FAKE.secret), dir).toEqual([]);
      expect(contains(dir, FAKE.id), dir).toEqual([]);
    }
    // Not even the variable names, which the main process's code alone knows.
    expect(contains(out.renderer, "MANGA_DANDANPLAY")).toEqual([]);
    expect(contains(out.renderer, "__MANGA_DANDANPLAY")).toEqual([]);
  });

  it("leaves them out of the build's own log", () => {
    expect(log.length).toBeGreaterThan(0);
    const text = log.join("\n");
    expect(text).not.toContain(FAKE.secret);
    expect(text).not.toContain(FAKE.id);
  });
});
