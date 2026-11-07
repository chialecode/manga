import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { buildPluginPackage } from "../packages/app-core/src/plugins/package.ts";
import { MANIFEST_NAME, sha256File, type AssetManifest } from "../apps/desktop/src/main/bundled-assets.ts";
import { repoRoot } from "./desktop-paths.ts";

/** Where the first party's signing key is kept on a maintainer's machine. It is never in the repository; the public half is in `packages/app-core/src/plugins/trust.ts`. */
export const defaultSigningKey = path.join(repoRoot, "dist/keys/plugin-first-party.pem");
export const pluginBuildDir = path.join(repoRoot, "dist/plugins");

/** The private key as text: the value of `MANGA_PLUGIN_SIGNING_KEY` (the text itself, or the path of a file that holds it), else the default file. */
export function signingKey(): string {
  const configured = process.env.MANGA_PLUGIN_SIGNING_KEY?.trim();
  if (configured) return configured.includes("BEGIN") ? configured : fs.readFileSync(configured, "utf8");
  if (!fs.existsSync(defaultSigningKey)) throw new Error("no signing key: set MANGA_PLUGIN_SIGNING_KEY to a key file, or keep the first party's key at dist/keys/plugin-first-party.pem");
  return fs.readFileSync(defaultSigningKey, "utf8");
}

type PluginSource = {
  manifest: Record<string, unknown> & { id: string; version: string; entry: string | null };
  bundle: { entry: string; out: string; alias?: Record<string, string>; external?: string[] };
};

type Licensed = { name: string; version: string; license: string; text: string };

/** The packages whose files went into a bundle, each with its declared licence and the licence text it ships, so the notice travels with the code. */
function licensesOf(inputs: string[], root: string): Licensed[] {
  const seen = new Map<string, Licensed>();
  const marker = "node_modules/";
  for (const input of inputs) {
    const path1 = input.replaceAll("\\", "/");
    const at = path1.lastIndexOf(marker);
    if (at < 0) continue;
    const rest = path1.slice(at + marker.length).split("/");
    const name = rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]!;
    if (seen.has(name)) continue;
    const base = path.resolve(root, path1.slice(0, at + marker.length), name);
    const manifestFile = path.join(base, "package.json");
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { version?: string; license?: string | { type?: string }; licenses?: Array<{ type?: string }> };
    const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type ?? manifest.licenses?.map((item) => item.type).join(" OR ") ?? "UNKNOWN";
    const file = fs.readdirSync(base).find((entry) => /^(licen[sc]e|copying)(\.[a-z]+)?$/i.test(entry));
    seen.set(name, { name, version: manifest.version ?? "", license, text: file ? fs.readFileSync(path.join(base, file), "utf8").trim() : "" });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A plugin's entry bundled with everything it needs into one file, and the manifest read from its `plugin.json`. */
export async function bundlePlugin(sourceDir: string): Promise<{ manifest: PluginSource["manifest"]; out: string; code: string; licenses: Licensed[] }> {
  const source = JSON.parse(fs.readFileSync(path.join(sourceDir, "plugin.json"), "utf8")) as PluginSource;
  const { manifest, bundle } = source;
  const alias = Object.fromEntries(Object.entries(bundle.alias ?? {}).map(([from, to]) => [from, path.resolve(sourceDir, to)]));
  const result = await build({
    entryPoints: [path.resolve(sourceDir, bundle.entry)], bundle: true, write: false, platform: "node", format: "esm", target: "node24", minify: false, legalComments: "none",
    alias, external: bundle.external ?? [], define: { PLUGIN_VERSION: JSON.stringify(manifest.version) }, logLevel: "silent", metafile: true, absWorkingDir: repoRoot,
    // Bundled CommonJS code asks for `require`; an ES module does not have one, so it is made here.
    banner: { js: 'import { createRequire as __mangaRequire } from "node:module"; const require = __mangaRequire(import.meta.url);' },
  });
  return { manifest, out: bundle.out, code: result.outputFiles[0]!.text, licenses: licensesOf(Object.keys(result.metafile.inputs), repoRoot) };
}

/** The text that names every package bundled into a plugin with its licence, written into the package next to the code. */
export function noticesText(manifest: { id: string; name?: unknown; version: string }, licenses: Licensed[]): string {
  const lines = [`${String(manifest.name ?? manifest.id)} ${manifest.version}`, "", "This package bundles the open-source packages below; each is distributed under the licence named next to it.", ""];
  for (const item of licenses) lines.push(`- ${item.name} ${item.version}  (${item.license})`);
  for (const item of licenses) if (item.text) lines.push("", "=".repeat(78), `${item.name} ${item.version} - ${item.license}`, "=".repeat(78), "", item.text);
  return `${lines.join("\n")}\n`;
}

export type PackedPlugin = { file: string; id: string; version: string; bytes: number; name: string; notices: string; licenses: string[]; packages: number };

/** Builds one plugin from its source folder into a package signed with the given key (the first party's by default). */
export async function packPlugin(sourceDir: string, options: { out?: string; privateKeyPem?: string } = {}): Promise<PackedPlugin> {
  const { manifest, out: entry, code, licenses } = await bundlePlugin(sourceDir);
  const notices = noticesText(manifest, licenses);
  const privateKeyPem = options.privateKeyPem ?? signingKey();
  createPrivateKey(privateKeyPem);
  const bytes = buildPluginPackage({ manifest, files: { [entry]: code, "NOTICES.txt": notices }, privateKeyPem });
  const outDir = options.out ?? pluginBuildDir;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${manifest.id}-${manifest.version}.manga-plugin`);
  fs.writeFileSync(file, bytes);
  return { file, id: manifest.id, version: manifest.version, bytes: bytes.length, name: String(manifest.name ?? manifest.id), notices, licenses: [...new Set(licenses.map((item) => item.license))].sort(), packages: licenses.length };
}

/** Every plugin under `plugins/`, built and signed. */
export async function packAllPlugins(options: { out?: string; privateKeyPem?: string } = {}) {
  const root = path.join(repoRoot, "plugins");
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "plugin.json"))) out.push(await packPlugin(path.join(root, entry.name), options));
  }
  return out;
}

const LIBRARIES_SUFFIX = " (bundled libraries)";

/**
 * Builds the plugins that come with the application into `<resources>/plugins`, each with its notice file beside it, and adds them to the manifest
 * `stageBundledAssets` wrote there. They are offered in the plugin settings and never installed by themselves; the key that signs them is the one the
 * application trusts as the first party's, so a package built with any other key is shown as untrusted.
 */
export async function stageBundledPlugins(resourcesDir: string, options: { privateKeyPem?: string } = {}): Promise<AssetManifest> {
  const manifestFile = path.join(resourcesDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestFile)) throw new Error(`packaging: ${MANIFEST_NAME} is missing; the bundled assets are staged before the plugins`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as AssetManifest;
  const dir = path.join(resourcesDir, "plugins");
  fs.rmSync(dir, { recursive: true, force: true });
  const built = await packAllPlugins({ out: dir, privateKeyPem: options.privateKeyPem });
  manifest.assets = manifest.assets.filter((asset) => !asset.id.startsWith("plugin:"));
  manifest.notices = manifest.notices.filter((notice) => !notice.name.endsWith(LIBRARIES_SUFFIX));
  for (const item of built) {
    const noticeName = `${item.id}.NOTICES.txt`;
    fs.writeFileSync(path.join(dir, noticeName), item.notices);
    const relative = `plugins/${path.basename(item.file)}`;
    manifest.assets.push({ id: `plugin:${item.id}`, path: relative, bytes: fs.statSync(item.file).size, sha256: sha256File(item.file) });
    manifest.notices.push({ name: `${item.name}${LIBRARIES_SUFFIX}`, version: item.version, license: item.licenses.join(", "), source: "https://github.com/webtorrent/webtorrent", files: [`plugins/${noticeName}`] });
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
