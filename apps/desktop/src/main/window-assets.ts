import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function defaultBaseDir(): string {
  return typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolves the channel-appropriate window/app icon across both packaged builds (`resources/`)
 * and unpackaged development/source runs (`apps/desktop/assets/`).
 * Node built-ins only so light open (`light/main.ts`) and full main (`index.ts`) share it cleanly.
 */
export function resolveAppIconPath(options: {
  channel: "release" | "development" | "test";
  packaged: boolean;
  resourcesPath: string;
  baseDir?: string;
  existsSync?: (file: string) => boolean;
}): string | undefined {
  const exists = options.existsSync ?? fs.existsSync;
  const dir = options.baseDir ?? defaultBaseDir();
  const source = options.channel === "development" ? "icon-dev" : "icon";
  const devAssets = [
    path.resolve(dir, `../../assets/${source}.ico`),
    path.resolve(dir, `../../assets/${source}.png`),
  ];
  const packagedAssets = [
    ...(options.channel === "development" ? [path.join(options.resourcesPath, "icon-dev.ico")] : []),
    path.join(options.resourcesPath, "icon.ico"),
    ...(options.channel === "development" ? [path.join(options.resourcesPath, "icon-dev.png")] : []),
    path.join(options.resourcesPath, "icon.png"),
  ];
  const candidates = options.packaged ? [...packagedAssets, ...devAssets] : [...devAssets, ...packagedAssets];
  return candidates.find((file) => exists(file));
}

/** Resolves a Vite renderer window URL for both dev server and packaged HTML output. */
export function resolveRendererUrl(options: {
  devServerUrl: string | undefined;
  viteName: string;
  baseDir: string;
  appendIndexHtml?: boolean;
}): string {
  if (options.devServerUrl) {
    return options.appendIndexHtml ? `${options.devServerUrl}/index.html` : options.devServerUrl;
  }
  return pathToFileURL(path.join(options.baseDir, `../renderer/${options.viteName}/index.html`)).href;
}
