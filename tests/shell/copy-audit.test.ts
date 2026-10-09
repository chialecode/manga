import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { catalogs } from "../../packages/i18n/src/messages.ts";

/**
 * The checks on what the window says (AT-100, A-93), run with the rest of `verify`: a message nobody uses is deleted rather than left to rot, an internal
 * identifier is not drawn as it is, and the interface does not talk about features that were taken away. They read the sources; nothing is rendered.
 * A key built at run time is recognised by the fixed parts around its variable part, so a message in use is never reported as unused.
 */
const root = path.resolve(import.meta.dirname, "../..");

function files(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, found);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

const catalogDir = path.join(root, "packages/i18n/src");
const isCatalog = (file: string) => path.dirname(file) === catalogDir && /^messages.*\.ts$/.test(path.basename(file));
const sources = [
  ...files(path.join(root, "apps")),
  ...files(path.join(root, "packages")),
].filter((file) => !isCatalog(file));
const text = new Map(sources.map((file) => [file, fs.readFileSync(file, "utf8")]));
const keys = Object.keys(catalogs["zh-CN"]);

const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The shape of a key built from `shelf.state.${state}.video`: the fixed parts, with one word (no dot) where the variable part is. */
const shapeOf = (fixed: string[]) => new RegExp(`^${fixed.map(escape).join("[\\w-]+")}$`);

/**
 * The fixed parts of the template literal that starts at `from` (just after its opening backtick), or null when a fixed part is not a plain word path.
 * A variable part may hold braces and another template literal (`${t(`scan.status.${s}`)}`), so it is skipped by counting braces.
 */
function templateShape(source: string, from: number): { fixed: string[]; end: number } | null {
  const fixed: string[] = [""];
  let i = from;
  while (i < source.length && source[i] !== "`") {
    if (source[i] === "$" && source[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth += 1;
        else if (source[i] === "}") depth -= 1;
        i += 1;
      }
      fixed.push("");
    } else {
      fixed[fixed.length - 1] += source[i];
      i += 1;
    }
  }
  return fixed.length > 1 && fixed.every((part) => /^[\w.-]*$/.test(part)) ? { fixed, end: i } : null;
}

/**
 * Prefixes under which a key is picked by an identifier that itself holds dots, so no shape with one word can describe it: the operation log stores
 * `log.<command id>` as the summary of a record (`log.library.importText`), and a key binding is named `keys.<binding id>` (`keys.video.seekBack`).
 */
const BY_DOTTED_ID = ["log.", "keys."];

/**
 * Every message key a source names whole, and the shapes of the keys it builds: a template literal with a fixed start and one word (no dot) where each
 * variable part is (`` `shelf.state.${state}` ``), or a prefix joined to a word (`"shelf.title." + kind`). Templates for anything else (track ids, record
 * ids, whose fixed part has no dot) are not messages, and a shape of one word and a dot (`mindmap.${direction}`) reaches no more than the keys of that form.
 */
function usage() {
  const whole = new Set<string>();
  const shapes: RegExp[] = [new RegExp(`^(?:${BY_DOTTED_ID.map(escape).join("|")})`)];
  const quoted = /(["'`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g;
  // A template literal that starts with a namespace (`shelf.state.`) and goes on with a variable part.
  const template = /`([a-z][\w-]*(?:\.[\w-]+)*\.)\$\{/gi;
  const prefixed = /(["'])([A-Za-z][\w-]*(?:\.[\w-]+)*\.)\1\s*\+/g;
  for (const source of text.values()) {
    for (const match of source.matchAll(quoted)) whole.add(match[2]!);
    for (const match of source.matchAll(template)) {
      const shape = templateShape(source, match.index! + 1);
      if (!shape) continue;
      // `mindmap.${direction}` is a command name; a key of one namespace word and a variable part is one only where the program says so.
      const oneWord = !shape.fixed[0]!.slice(0, -1).includes(".");
      if (oneWord && !/^`\s*as\s+MessageKey/.test(source.slice(shape.end, shape.end + 24))) continue;
      shapes.push(shapeOf(shape.fixed));
    }
    for (const match of source.matchAll(prefixed)) shapes.push(new RegExp(`^${escape(match[2]!)}[\\w-]+$`));
  }
  return { whole, shapes };
}

describe("every message in the catalogs is used (AT-100)", () => {
  it("has no message that no source names, builds the name of, or lists", () => {
    const { whole, shapes } = usage();
    const unused = keys.filter((key) => !whole.has(key) && !shapes.some((shape) => shape.test(key)));
    expect(unused).toEqual([]);
  });

  it("recognises a key built at run time by its fixed parts (the check's own test)", () => {
    const shape = shapeOf(["shelf.state.", ".video"]);
    expect(shape.test("shelf.state.reading.video")).toBe(true);
    expect(shape.test("shelf.state.reading")).toBe(false);
    expect(shape.test("shelf.state.a.b.video")).toBe(false);
    // A template inside the variable part of another one is read on its own.
    const inner = "x = `${t(`scan.status.${last.status}`)} and ${{ a: 1 }.a}`";
    const found = [...inner.matchAll(/`([a-z][\w-]*(?:\.[\w-]+)*\.)\$\{/gi)].map((m) => templateShape(inner, m.index! + 1));
    expect(found.map((shape) => shape?.fixed)).toEqual([["scan.status.", ""]]);
  });
});

describe("every message is written once (AT-100)", () => {
  // The catalogs are merged in order and the later one wins, so a key written in two of them leaves the first as text nobody sees.
  it("has no key in more than one catalog file", () => {
    const where = new Map<string, string[]>();
    for (const name of fs.readdirSync(catalogDir).filter((item) => /^messages.*\.ts$/.test(item))) {
      fs.readFileSync(path.join(catalogDir, name), "utf8").split("\n").forEach((line, index) => {
        const key = /^\s*"([^"]+)":/.exec(line)?.[1];
        if (key) where.set(key, [...(where.get(key) ?? []), `${name}:${index + 1}`]);
      });
    }
    expect([...where].filter(([, places]) => places.length > 1)).toEqual([]);
  });
});

describe("the interface does not speak of features that were taken away (AT-100)", () => {
  // The library comes from library locations only (A-69); there is no import dialog, no title bar row (A-76) and nothing is kept in a managed store (A-80).
  const GONE: Array<[RegExp, string]> = [
    [/导入(?:本地)?文件(?!夹)/, "importing files"],
    [/导入(?:小说|漫画|动漫|书籍|整个文件夹)/, "importing a book, a comic, an anime or a folder"],
    [/导入 TXT/, "importing a TXT file"],
    [/尚未导入资源/, "no resources imported"],
    [/标题栏/, "the title bar"],
    [/托管/, "managed files"],
  ];
  for (const [pattern, name] of GONE) {
    it(`says nothing about ${name}`, () => {
      const hits = Object.entries(catalogs["zh-CN"]).filter(([, value]) => pattern.test(value)).map(([key, value]) => `${key}: ${value}`);
      expect(hits).toEqual([]);
    });
  }
});

describe("the interface does not draw an internal identifier as it is (AT-100)", () => {
  // A value that the program uses as a name for a kind, a protocol, a runtime or a purpose is shown through a label, never as it is stored.
  const FIELDS = ["kind", "mediaKind", "purpose", "protocol", "runtime", "decision", "format", "stage", "reason", "origin", "provider"].join("|");
  /** Files that exist to show the program's own facts to the person who debugs it, where the raw value is the point. */
  const FACT_PANELS = [/debug-/];
  const field = String.raw`(?:String\(\s*)?[A-Za-z_][\w.]*\.(?:${FIELDS})\s*\)?`;
  const alone = new RegExp(String.raw`>\s*\{\s*${field}\s*\}\s*<`);
  const arm = new RegExp(String.raw`:\s*String\(\s*[A-Za-z_][\w.]*\.(?:${FIELDS})\s*\)\s*\}`);

  const hits = (pattern: RegExp) => {
    const found: string[] = [];
    for (const [file, source] of text) {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      if (!relative.startsWith("apps/desktop/src/renderer/") || !relative.endsWith(".tsx") || FACT_PANELS.some((panel) => panel.test(relative))) continue;
      source.split("\n").forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        if (pattern.test(line)) found.push(`${relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    return found;
  };

  it("renders no field that holds an identifier as the whole text of an element", () => {
    expect(hits(alone)).toEqual([]);
  });

  it("renders no such field as the last arm of a choice that makes the text", () => {
    expect(hits(arm)).toEqual([]);
  });

  it("finds what it looks for (the check's own test)", () => {
    expect(alone.test("<span>{item.kind}</span>")).toBe(true);
    expect(alone.test("<span>{String(connection.protocol)}</span>")).toBe(true);
    expect(arm.test('<div>{a ? t("x") : String(item.kind)}</div>')).toBe(true);
    expect(alone.test("<span>{protocolName(t, connection.protocol)}</span>")).toBe(false);
    expect(arm.test('<div>{a ? t("x") : labelOf(item.kind)}</div>')).toBe(false);
  });
});

describe("every word the window shows comes from the catalogs (AT-100)", () => {
  // A line of the renderer that holds Chinese outside a comment is copy that skips the catalogs. These files hold Chinese that is not copy for the person.
  const NOT_COPY: Array<[RegExp, string]> = [
    [/^apps\/desktop\/src\/renderer\/lib\/chat-model\.ts$/, "the names of the fields of the context block that is sent to the model"],
    [/^apps\/desktop\/src\/renderer\/lib\/debug-redact\.ts$/, "the placeholders that replace a hidden value in the debug panel's copy of a request"],
  ];
  it("has no Chinese text in the renderer outside the catalogs", () => {
    const found: string[] = [];
    for (const [file, source] of text) {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      if (!relative.startsWith("apps/desktop/src/renderer/") || NOT_COPY.some(([pattern]) => pattern.test(relative))) continue;
      source.split("\n").forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        const code = line.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/.*$/, "");
        if (/[一-鿿]/.test(code)) found.push(`${relative}:${index + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(found).toEqual([]);
  });
});
