// Builds and signs the plugins under plugins/ into dist/plugins (or --out). The signing key is MANGA_PLUGIN_SIGNING_KEY or dist/keys/plugin-first-party.pem and is never printed.
import path from "node:path";
import { packAllPlugins, packPlugin } from "./desktop-plugins.ts";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? path.resolve(args[outAt + 1] ?? "") : undefined;
const only = args.filter((arg, index) => !arg.startsWith("--") && index !== outAt + 1);
try {
  const built = only.length ? [await packPlugin(path.resolve(only[0]), { out })] : await packAllPlugins({ out });
  for (const item of built) console.log(`${item.id} ${item.version} -> ${path.relative(process.cwd(), item.file)} (${(item.bytes / 1024).toFixed(0)} KiB)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
