import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBuildInfo,
  checkAppUpdateConfig,
  readBuildInfoIfPresent,
  resolveBuildVersion,
  writeBuildInfo,
} from "./version-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_ICON_SVG = path.join(repoRoot, "apps/desktop/assets/icon.svg");
export const DEFAULT_ICON_PNG = path.join(repoRoot, "apps/desktop/assets/icon.png");
export const DEFAULT_ICON_ICO = path.join(repoRoot, "apps/desktop/assets/icon.ico");
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

export const INSTALLER_META = {
  description: "二次元阅读观看、记录与辅助创作工作台",
  author: "chialecode",
  homepage: "https://github.com/chialecode/manga",
  copyright: "Copyright © 2026 chialecode",
  publisherName: ["chialecode"],
  language: "2052",
  installerLanguages: ["zh_CN"],
};

/**
 * The per-user installer (A-119, 计划 4.6, 4.8): electron-builder's NSIS target over the directory Forge packaged (`--prepackaged`). No administrator rights,
 * the folder can be changed, the default is `%LOCALAPPDATA%\Programs\manga` (development: `manga-dev`), and uninstalling removes the program, its
 * shortcuts and its uninstall entry only: the data (A-118) and the person's files stay. The two channels differ in everything Windows tells apart, so
 * both can be installed at once. Test identities (`TEST_CHANNEL_INSTALL`, 计划 4.8) isolate automated installer and update runs from real installations.
 */
export const CHANNEL_INSTALL = {
  release: { appId: "app.manga.desktop", productName: "MANGA", executableName: "manga", dirName: "manga", shortcutName: "MANGA" },
  development: { appId: "app.manga.desktop.dev", productName: "MANGA Dev", executableName: "manga-dev", dirName: "manga-dev", shortcutName: "MANGA Dev" },
};

export const TEST_CHANNEL_INSTALL = {
  release: {
    appId: "app.manga.desktop.test",
    productName: "MANGA Test",
    executableName: "manga-test",
    dirName: "manga-test",
    shortcutName: "MANGA Test",
    channel: "release",
    testIdentity: true,
  },
  development: {
    appId: "app.manga.desktop.dev.test",
    productName: "MANGA Dev Test",
    executableName: "manga-dev-test",
    dirName: "manga-dev-test",
    shortcutName: "MANGA Dev Test",
    channel: "development",
    testIdentity: true,
  },
};

export function installMeta(channel, { testIdentity = false } = {}) {
  const table = testIdentity ? TEST_CHANNEL_INSTALL : CHANNEL_INSTALL;
  const meta = table[channel];
  if (!meta) throw new Error(`unknown installer channel: ${String(channel)}`);
  return meta;
}

/**
 * "Open with" (L5, 4.5, Q-39 item 2): the types MANGA offers to open with light open. The same lists as `@manga/app-core/light` (a test keeps them
 * equal). `.zip` and folders are opened by dropping them on a light window or with "打开文件…", never registered.
 */
export const OPEN_WITH_TYPES = {
  video: [".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ogv", ".ts", ".webm", ".wmv"],
  comic: [".cbz"],
  image: [".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"],
};
const OPEN_WITH_LABELS = { video: "视频", comic: "漫画", image: "图片" };
const OPEN_WITH_KIND = { video: "Video", comic: "Comic", image: "Image" };

/** Names of one identity's registration: its ProgIDs, the key under Software\MANGA and the name in RegisteredApplications. */
export function openWithIdentity(channel, { testIdentity = false } = {}) {
  const meta = installMeta(channel, { testIdentity });
  const prefix = testIdentity ? (channel === "release" ? "MANGA.Test" : "MANGA.DevTest") : channel === "release" ? "MANGA" : "MANGA.Dev";
  const channelKey = testIdentity ? (channel === "release" ? "Test" : "DevTest") : channel === "release" ? "Release" : "Dev";
  return {
    progIds: Object.fromEntries(Object.keys(OPEN_WITH_TYPES).map((kind) => [kind, `${prefix}.${OPEN_WITH_KIND[kind]}`])),
    exe: `${meta.executableName}.exe`,
    friendlyName: meta.productName,
    capabilities: `Software\\MANGA\\${channelKey}\\Capabilities`,
    capabilitiesRoot: `Software\\MANGA\\${channelKey}`,
    registeredName: meta.productName,
  };
}

/** Every registry value the installation writes for "Open with" (HKCU), as [key, name, value]; the stage installer checks them one by one. */
export function openWithValues(channel, { testIdentity = false, exePath = "$INSTDIR" } = {}) {
  const id = openWithIdentity(channel, { testIdentity });
  const exe = exePath === "$INSTDIR" ? `$INSTDIR\\${id.exe}` : exePath;
  const command = `"${exe}" --manga-light "%1"`;
  const values = [];
  for (const [kind, types] of Object.entries(OPEN_WITH_TYPES)) {
    const progId = id.progIds[kind];
    values.push([`Software\\Classes\\${progId}`, "", `${id.friendlyName} ${OPEN_WITH_LABELS[kind]}`]);
    values.push([`Software\\Classes\\${progId}\\DefaultIcon`, "", `${exe},0`]);
    values.push([`Software\\Classes\\${progId}\\shell\\open\\command`, "", command]);
    for (const ext of types) {
      // Only a named value under OpenWithProgids: the extension key's own default value is never written (it is not MANGA's).
      values.push([`Software\\Classes\\${ext}\\OpenWithProgids`, progId, ""]);
      values.push([`Software\\Classes\\Applications\\${id.exe}\\SupportedTypes`, ext, ""]);
      values.push([`${id.capabilities}\\FileAssociations`, ext, progId]);
    }
  }
  values.push([`Software\\Classes\\Applications\\${id.exe}`, "FriendlyAppName", id.friendlyName]);
  values.push([`Software\\Classes\\Applications\\${id.exe}\\shell\\open\\command`, "", command]);
  values.push([id.capabilities, "ApplicationName", id.friendlyName]);
  values.push([id.capabilities, "ApplicationDescription", "用 MANGA 轻量打开视频、CBZ 漫画与图片"]);
  values.push(["Software\\RegisteredApplications", id.registeredName, id.capabilities]);
  return values;
}

const nsisString = (value) => (value.includes("\"") ? `'${value}'` : `"${value}"`);

/** The NSIS lines that write and remove the registration (customInstall / customUnInstall), with SHChangeNotify(SHCNE_ASSOCCHANGED) after each. */
export function openWithNsis(channel, { testIdentity = false } = {}) {
  const id = openWithIdentity(channel, { testIdentity });
  const write = openWithValues(channel, { testIdentity }).map(([key, name, value]) => `  WriteRegStr HKCU "${key}" "${name}" ${nsisString(value)}`);
  const remove = [
    ...Object.values(id.progIds).map((progId) => `  DeleteRegKey HKCU "Software\\Classes\\${progId}"`),
    ...Object.entries(OPEN_WITH_TYPES).flatMap(([kind, types]) => types.flatMap((ext) => [
      `  DeleteRegValue HKCU "Software\\Classes\\${ext}\\OpenWithProgids" "${id.progIds[kind]}"`,
      // The keys go only when nothing else is left in them (no value, no default, no subkey): another program's entries and the extension's own
      // default value stay, and a key MANGA created alone does not linger.
      `  !insertmacro MangaDeleteBareKey "Software\\Classes\\${ext}\\OpenWithProgids"`,
      `  !insertmacro MangaDeleteBareKey "Software\\Classes\\${ext}"`,
    ])),
    `  DeleteRegKey HKCU "Software\\Classes\\Applications\\${id.exe}"`,
    `  DeleteRegValue HKCU "Software\\RegisteredApplications" "${id.registeredName}"`,
    `  DeleteRegKey HKCU "${id.capabilitiesRoot}"`,
    `  DeleteRegKey /ifempty HKCU "Software\\MANGA"`,
  ];
  const notify = "  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'";
  // A key is bare when it has no default value, no named value and no subkey; EnumRegValue cannot tell the default value from "none", so ReadRegStr asks.
  const bare = [
    "!macro MangaDeleteBareKey KEY",
    "  ClearErrors",
    '  ReadRegStr $R7 HKCU "${KEY}" ""',
    "  ${If} ${Errors}",
    '    EnumRegValue $R8 HKCU "${KEY}" 0',
    '    EnumRegKey $R9 HKCU "${KEY}" 0',
    '    ${If} $R8 == ""',
    '    ${AndIf} $R9 == ""',
    '      DeleteRegKey HKCU "${KEY}"',
    "    ${EndIf}",
    "  ${EndIf}",
    "!macroend",
    "",
  ];
  return [...bare, "!macro customInstall", ...write, notify, "!macroend", "", "!macro customUnInstall", ...remove, notify, "!macroend", ""];
}

/**
 * Whether an NSIS text writes the default value of an extension key (`Software\Classes\.ext` or HKCR `.ext`, value name ""), which would take
 * the file type away from the program the user chose.
 */
export function writesExtensionDefault(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*WriteReg\w+\s+(\w+)\s+"([^"]*)"\s+"([^"]*)"/i.exec(line);
    if (!match) continue;
    const key = match[2].replace(/^Software\\Classes\\/i, "");
    if (/^\.[^\\]+$/.test(key) && match[3] === "") return true;
  }
  return false;
}

/** Encode an array of `{ size, png }` buffers into a multi-resolution Windows `.ico` file. */
export function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    dir.writeUInt8(0, base + 2);
    dir.writeUInt8(0, base + 3);
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32LE(entry.png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((entry) => entry.png)]);
}

/** Inspect a Windows `.ico` buffer and verify its header, directory entries, and embedded PNG dimensions. */
export function inspectIco(icoBuffer) {
  const problems = [];
  if (!Buffer.isBuffer(icoBuffer) || icoBuffer.length < 22) {
    return { valid: false, count: 0, sizes: [], problems: ["ico too short"] };
  }
  const reserved = icoBuffer.readUInt16LE(0);
  const type = icoBuffer.readUInt16LE(2);
  const count = icoBuffer.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) problems.push(`invalid ico header (${reserved}, ${type})`);
  if (count < 1 || icoBuffer.length < 6 + count * 16) {
    problems.push("truncated ico directory");
    return { valid: false, count, sizes: [], problems };
  }
  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 16;
    const widthByte = icoBuffer.readUInt8(base);
    const heightByte = icoBuffer.readUInt8(base + 1);
    const bytesInRes = icoBuffer.readUInt32LE(base + 8);
    const imageOffset = icoBuffer.readUInt32LE(base + 12);
    const declaredWidth = widthByte === 0 ? 256 : widthByte;
    const declaredHeight = heightByte === 0 ? 256 : heightByte;
    if (declaredWidth !== declaredHeight) problems.push(`entry ${i} non-square (${declaredWidth}x${declaredHeight})`);
    if (imageOffset + bytesInRes > icoBuffer.length || bytesInRes < 24) {
      problems.push(`entry ${i} out of bounds`);
      continue;
    }
    const slice = icoBuffer.subarray(imageOffset, imageOffset + bytesInRes);
    if (slice.readUInt32BE(0) === 0x89504e47 && slice.toString("latin1", 12, 16) === "IHDR") {
      const pngWidth = slice.readUInt32BE(16);
      const pngHeight = slice.readUInt32BE(20);
      if (pngWidth !== declaredWidth || pngHeight !== declaredHeight) {
        problems.push(`entry ${i} png size ${pngWidth}x${pngHeight} != ${declaredWidth}`);
      }
      sizes.push(pngWidth);
    } else {
      sizes.push(declaredWidth);
    }
  }
  return { valid: problems.length === 0, count, sizes, problems };
}

/** Generate `icon.png` (512×512) and `icon.ico` (16..256 px) from `icon.svg` using `sharp`. */
export async function generateAppIcons({
  svgPath = DEFAULT_ICON_SVG,
  pngPath = DEFAULT_ICON_PNG,
  icoPath = DEFAULT_ICON_ICO,
  sizes = ICON_SIZES,
} = {}) {
  const { default: sharp } = await import("sharp");
  const svg = fs.readFileSync(svgPath);
  const png512 = await sharp(svg).resize(512, 512).png({ compressionLevel: 9 }).toBuffer();
  const entries = [];
  for (const size of sizes) {
    const png = await sharp(svg).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
    entries.push({ size, png });
  }
  const ico = encodeIco(entries);
  if (pngPath) {
    fs.mkdirSync(path.dirname(pngPath), { recursive: true });
    fs.writeFileSync(pngPath, png512);
  }
  if (icoPath) {
    fs.mkdirSync(path.dirname(icoPath), { recursive: true });
    fs.writeFileSync(icoPath, ico);
  }
  return { png512, ico, sizes };
}

/**
 * Generate the `app-update.yml` placed in `resources/` of a release installation (计划 3.1, 4.4).
 * `electron-updater` 6.8.11's `NsisUpdater.verifySignature` only invokes `verifyUpdateCodeSignature` when `publisherName`
 * is present in `app-update.yml`; without it, `verifySignature` returns `null` and skips verification completely.
 */
export function appUpdateYaml({
  owner = "chialecode",
  repo = "manga",
  publisherName = INSTALLER_META.publisherName,
} = {}) {
  const lines = [
    "provider: github",
    `owner: ${owner}`,
    `repo: ${repo}`,
    "updaterCacheDirName: updater",
  ];
  if (Array.isArray(publisherName) && publisherName.length > 0) {
    lines.push("publisherName:");
    for (const name of publisherName) lines.push(`  - ${name}`);
  } else if (typeof publisherName === "string" && publisherName.trim()) {
    lines.push(`publisherName: ${publisherName.trim()}`);
  }
  return `${lines.join("\n")}\n`;
}

export { checkAppUpdateConfig };

/** The NSIS lines electron-builder includes: the default folder named for the channel unless an earlier installation or `/D=` chose another. */
export function installerInclude(channel, { testIdentity = false } = {}) {
  const { dirName } = installMeta(channel, { testIdentity });
  return [
    `; The default folder is ${dirName}, not the product name (A-119). An earlier installation's folder and /D= win.`,
    "!macro customInit",
    `  ReadRegStr $R1 HKCU "\${INSTALL_REGISTRY_KEY}" InstallLocation`,
    "  !insertmacro GetDParameter $R0",
    `  \${If} $R1 == ""`,
    `  \${AndIf} $R0 == ""`,
    `    StrCpy $INSTDIR "$LOCALAPPDATA\\Programs\\${dirName}"`,
    "  ${EndIf}",
    "!macroend",
    "",
    `; "Open with" (4.5): ProgIDs, OpenWithProgids values, Applications and Capabilities in HKCU; the extension keys' default values are never written.`,
    ...openWithNsis(channel, { testIdentity }),
  ].join("\r\n");
}

/** The electron-builder configuration of one channel; `checkInstallerConfig` reads the same fields back. */
export function installerConfig(channel, { output, include, version, testIdentity = false, icon = DEFAULT_ICON_ICO }) {
  const meta = installMeta(channel, { testIdentity });
  return {
    appId: meta.appId,
    productName: meta.productName,
    executableName: meta.executableName,
    copyright: INSTALLER_META.copyright,
    extraMetadata: {
      version,
      description: INSTALLER_META.description,
      author: { name: INSTALLER_META.author },
      homepage: INSTALLER_META.homepage,
    },
    directories: { output },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      icon,
      signtoolOptions: {
        publisherName: [...INSTALLER_META.publisherName],
      },
      signAndEditExecutable: false,
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
      language: INSTALLER_META.language,
      installerLanguages: [...INSTALLER_META.installerLanguages],
      installerIcon: icon,
      uninstallerIcon: icon,
      installerHeaderIcon: icon,
      shortcutName: meta.shortcutName,
      uninstallDisplayName: meta.productName,
      include,
      artifactName: `${meta.dirName}-setup-\${version}.\${ext}`,
    },
    publish: null,
  };
}

/** What the installer must be (计划 4.6, 4.8, 4.10); a list of problems, empty when it is right. */
export function checkInstallerConfig(channel, config, includeText, { testIdentity = false, appUpdateText } = {}) {
  const meta = installMeta(channel, { testIdentity });
  const problems = [];
  if (config.appId !== meta.appId) problems.push(`appId ${config.appId}`);
  if (config.productName !== meta.productName) problems.push(`productName ${config.productName}`);
  if (config.nsis?.perMachine !== false) problems.push("not per user");
  if (config.nsis?.oneClick !== false) problems.push("one-click");
  if (config.nsis?.allowElevation !== false) problems.push("asks for elevation");
  if (config.nsis?.allowToChangeInstallationDirectory !== true) problems.push("folder cannot be changed");
  if (config.nsis?.deleteAppDataOnUninstall !== false) problems.push("uninstall deletes data");
  if (!includeText.includes(`$LOCALAPPDATA\\Programs\\${meta.dirName}"`)) problems.push("default folder");
  if (config.copyright !== INSTALLER_META.copyright) problems.push("missing copyright");
  if (config.extraMetadata?.description !== INSTALLER_META.description) problems.push("missing description");
  const authorName = typeof config.extraMetadata?.author === "string" ? config.extraMetadata.author : config.extraMetadata?.author?.name;
  if (authorName !== INSTALLER_META.author) problems.push("missing author");
  if (config.extraMetadata?.homepage !== INSTALLER_META.homepage) problems.push("missing homepage");
  if (!config.win?.icon || !config.nsis?.installerIcon || !config.nsis?.uninstallerIcon || !config.nsis?.installerHeaderIcon) {
    problems.push("missing icon");
  }
  if (config.nsis?.language !== INSTALLER_META.language || !Array.isArray(config.nsis?.installerLanguages) || !config.nsis.installerLanguages.includes("zh_CN")) {
    problems.push("not Simplified Chinese (zh_CN / 2052)");
  }
  if (config.nsis?.runAfterFinish !== true) problems.push("runAfterFinish disabled");
  // "Open with" is the include's own registration (4.5), never electron-builder's file associations, which take over the extension's default.
  if (config.fileAssociations !== undefined || config.win?.fileAssociations !== undefined || config.nsis?.fileAssociations !== undefined) problems.push("fileAssociations is set");
  if (writesExtensionDefault(includeText)) problems.push("writes an extension's default value");
  const wanted = openWithNsis(channel, { testIdentity }).filter((line) => line.trim().startsWith("WriteRegStr") || line.trim().startsWith("Delete"));
  if (wanted.some((line) => !includeText.includes(line))) problems.push("\"Open with\" registration missing or different");
  if (appUpdateText !== undefined) {
    problems.push(...checkAppUpdateConfig(appUpdateText));
  }
  return problems;
}

/** Stamp the MANGA icon and version strings onto a staged Windows PE executable via `resedit`. */
export async function applyExecutableMetadata(exePath, {
  iconPath = DEFAULT_ICON_ICO,
  productName,
  description = INSTALLER_META.description,
  companyName = INSTALLER_META.author,
  copyright = INSTALLER_META.copyright,
  executableName,
  version,
}) {
  if (!fs.existsSync(exePath)) return false;
  const bytes = fs.readFileSync(exePath);
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const resedit = await import("resedit");
  const exe = resedit.NtExecutable.from(bytes, { ignoreCert: true });
  const res = resedit.NtExecutableResource.from(exe);
  const viList = resedit.Resource.VersionInfo.fromEntries(res.entries);
  const vi = viList.length > 0 ? viList[0] : resedit.Resource.VersionInfo.createEmpty();
  const langs = vi.getAllLanguagesForStringValues();
  const lang = langs[0] ?? { lang: 1033, codepage: 1200 };
  const [maj = 0, min = 1, pat = 0] = String(version ?? "0.1.0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  vi.setFileVersion(maj, min, pat, 0, lang.lang);
  vi.setProductVersion(maj, min, pat, 0, lang.lang);
  vi.setStringValues(lang, {
    CompanyName: companyName,
    FileDescription: description,
    FileVersion: String(version ?? "0.1.0"),
    InternalName: executableName,
    LegalCopyright: copyright,
    OriginalFilename: `${executableName}.exe`,
    ProductName: productName,
    ProductVersion: String(version ?? "0.1.0"),
  });
  vi.outputToResourceEntries(res.entries);
  if (iconPath && fs.existsSync(iconPath)) {
    const iconFile = resedit.Data.IconFile.from(fs.readFileSync(iconPath));
    const groups = resedit.Resource.IconGroupEntry.fromEntries(res.entries);
    const groupId = groups[0]?.id ?? 1;
    const groupLang = groups[0]?.lang ?? lang.lang;
    resedit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, groupLang, iconFile.icons.map((item) => item.data));
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return true;
}

/**
 * Make the installer of one channel from a packaged directory. The channel (and optional testIdentity) and `build.json` are written into the copy it
 * installs, `app-update.yml` with `publisherName: ["chialecode"]` is written for the release channel, and the executable carries the channel's name,
 * icon and version metadata so the installations tell each other apart.
 */
export async function buildInstaller({ appDir, channel, workDir, version, commit, testIdentity = false }) {
  const meta = installMeta(channel, { testIdentity });
  const suffix = testIdentity ? `${channel}-test` : channel;
  const existingBuild = readBuildInfoIfPresent(path.join(appDir, "resources"));
  const effectiveVersion = version?.trim() || existingBuild?.version || resolveBuildVersion(channel, { cwd: repoRoot });
  const workRoot = path.resolve(workDir);
  const staged = path.join(workRoot, `app-${suffix}`);
  if (path.dirname(staged) !== workRoot) throw new Error("installer staging escaped its named work directory");
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(appDir, staged, { recursive: true });
  const resourcesDir = path.join(staged, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  const channelPayload = testIdentity ? { channel, testIdentity: true } : { channel };
  fs.writeFileSync(path.join(resourcesDir, "channel.json"), `${JSON.stringify(channelPayload)}\n`);
  const buildInfo = writeBuildInfo(
    resourcesDir,
    createBuildInfo({
      channel,
      version: effectiveVersion,
      commit: commit ?? existingBuild?.commit,
      builtAt: existingBuild?.builtAt,
      schemaVersion: existingBuild?.schemaVersion,
      cwd: repoRoot,
    }),
  );
  let appUpdateText;
  const appUpdatePath = path.join(resourcesDir, "app-update.yml");
  if (channel === "release") {
    appUpdateText = appUpdateYaml();
    fs.writeFileSync(appUpdatePath, appUpdateText);
  } else {
    fs.rmSync(appUpdatePath, { force: true });
  }
  const targetExe = path.join(staged, `${meta.executableName}.exe`);
  if (meta.executableName !== "manga" && fs.existsSync(path.join(staged, "manga.exe"))) {
    fs.renameSync(path.join(staged, "manga.exe"), targetExe);
  }
  await applyExecutableMetadata(targetExe, {
    iconPath: DEFAULT_ICON_ICO,
    productName: meta.productName,
    executableName: meta.executableName,
    version: effectiveVersion,
  });
  const include = path.join(workDir, `installer-${suffix}.nsh`);
  // With a BOM: makensis reads an include without one in the ANSI code page, and the type names are Chinese.
  fs.writeFileSync(include, `\uFEFF${installerInclude(channel, { testIdentity })}`);
  const output = path.join(workDir, `out-${suffix}`);
  const config = installerConfig(channel, { output, include, version: effectiveVersion, testIdentity });
  const problems = checkInstallerConfig(channel, config, fs.readFileSync(include, "utf8"), {
    testIdentity,
    ...(channel === "release" ? { appUpdateText: fs.readFileSync(appUpdatePath, "utf8") } : {}),
  });
  if (problems.length) throw new Error(`installer configuration of ${suffix}: ${problems.join(", ")}`);
  const { build, Platform, Arch } = await import("electron-builder");
  const started = Date.now();
  const made = await build({ targets: Platform.WINDOWS.createTarget("nsis", Arch.x64), prepackaged: staged, config, publish: "never" });
  const installer = made.find((file) => file.endsWith(".exe") && !file.endsWith("__uninstaller.exe"));
  if (!installer) throw new Error("electron-builder made no installer");
  fs.rmSync(staged, { recursive: true, force: true });
  return { installer, bytes: fs.statSync(installer).size, ms: Date.now() - started, config, version: effectiveVersion, buildInfo, testIdentity };
}

/** Use electron-builder's content-defined chunker, the same block map its updater consumes. */
export async function buildInstallerBlockMap(installer, destination = `${installer}.blockmap`) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { buildBlockMap } = builderRequire("app-builder-lib/out/targets/blockmap/blockmap");
  return buildBlockMap(installer, "gzip", destination);
}

const UNINSTALL_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

function runPowershell(command) {
  if (process.platform !== "win32") return "";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) throw new Error("unable to inspect Windows installation state");
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

/**
 * Read HKCU registry values: `queries` are `[key, name]` pairs (name "" is the default value), answered in order with the string or null; `keys`
 * answers whether each key exists. The list goes in as JSON through the environment, so no key is ever spliced into the command.
 */
export function readRegistryValues(queries, keys = []) {
  if (process.platform !== "win32") return { values: queries.map(() => null), keys: keys.map(() => false) };
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$q = $env:MANGA_REG_QUERY | ConvertFrom-Json",
    "$values = @(foreach ($pair in $q.values) { $k = Get-Item -LiteralPath ('HKCU:\\' + $pair[0]) -ErrorAction SilentlyContinue; if ($k) { $v = $k.GetValue($pair[1], $null, 'DoNotExpandEnvironmentNames'); if ($null -eq $v) { $null } else { [string]$v } } else { $null } })",
    "$keys = @(foreach ($key in $q.keys) { Test-Path -LiteralPath ('HKCU:\\' + $key) })",
    "[pscustomobject]@{ values = $values; keys = $keys } | ConvertTo-Json -Compress -Depth 3",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    env: { ...process.env, MANGA_REG_QUERY: JSON.stringify({ values: queries, keys }) },
  });
  if (result.status !== 0) throw new Error("unable to read the registry");
  const parsed = JSON.parse(result.stdout.trim() || "{}");
  const list = (value) => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);
  const values = list(parsed.values);
  const present = list(parsed.keys);
  return { values: queries.map((_, index) => values[index] ?? null), keys: keys.map((_, index) => present[index] === true) };
}

/** Every extension MANGA registers, flattened. */
export const OPEN_WITH_EXTENSIONS = Object.values(OPEN_WITH_TYPES).flat();

/**
 * The state of one identity's "Open with" registration, plus the default value of every registered extension (which MANGA must never change).
 * `values` lists each expected value and what is there now; `keys` whether each of the identity's own keys exists; `extensionDefaults` a hash.
 */
export function readOpenWithState(channel, { testIdentity = false, exePath } = {}) {
  const id = openWithIdentity(channel, { testIdentity });
  const expected = openWithValues(channel, { testIdentity, exePath: exePath ?? "$INSTDIR" });
  const ownKeys = [...Object.values(id.progIds).map((progId) => `Software\\Classes\\${progId}`), `Software\\Classes\\Applications\\${id.exe}`, id.capabilitiesRoot];
  const defaults = OPEN_WITH_EXTENSIONS.map((ext) => [`Software\\Classes\\${ext}`, ""]);
  const read = readRegistryValues([...expected.map(([key, name]) => [key, name]), ...defaults], ownKeys);
  const now = read.values.slice(0, expected.length);
  const extensionDefaults = read.values.slice(expected.length);
  return {
    values: expected.map(([key, name, value], index) => ({ key, name, expected: value, actual: now[index] })),
    keys: Object.fromEntries(ownKeys.map((key, index) => [key, read.keys[index]])),
    extensionDefaults: createHash("sha256").update(JSON.stringify(extensionDefaults)).digest("hex").slice(0, 16),
  };
}

export function readRegistryInstallations() {
  const text = runPowershell(
    `Get-ChildItem '${UNINSTALL_KEY}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p -and $p.DisplayName) { [pscustomobject]@{ Key = $_.PSChildName; DisplayName = [string]$p.DisplayName; DisplayVersion = [string]$p.DisplayVersion; Publisher = [string]$p.Publisher; InstallLocation = [string]$p.InstallLocation; UninstallString = [string]$p.UninstallString } } } | ConvertTo-Json -Compress`,
  );
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => {
      const command = String(entry.UninstallString ?? "").replace(/^"([^"]+)".*$/, "$1");
      const installLocation = entry.InstallLocation ? String(entry.InstallLocation) : command ? path.dirname(command) : "";
      return {
        Key: String(entry.Key ?? ""),
        DisplayName: String(entry.DisplayName ?? ""),
        DisplayVersion: String(entry.DisplayVersion ?? ""),
        Publisher: String(entry.Publisher ?? ""),
        InstallLocation: installLocation,
        UninstallString: String(entry.UninstallString ?? ""),
      };
    });
  } catch { throw new Error("invalid Windows installation state"); }
}

/** Remove only the two explicitly reserved test identities, including leftovers of interrupted checks. */
export async function removeTestInstallations(channels = ["release", "development"]) {
  if (process.platform !== "win32") return;
  for (const channel of channels) {
    const meta = TEST_CHANNEL_INSTALL[channel];
    const entry = readRegistryInstallations().find((item) => item.DisplayName === meta.productName);
    if (entry) {
      const uninstaller = entry.UninstallString.replace(/^"([^"]+)".*$/, "$1");
      const location = path.resolve(entry.InstallLocation);
      if (uninstaller && fs.existsSync(uninstaller)) {
        if (path.dirname(path.resolve(uninstaller)).toLowerCase() !== location.toLowerCase()) throw new Error("test uninstaller is outside its registered installation");
        const channelFile = path.join(location, "resources/channel.json");
        const identity = fs.existsSync(channelFile) ? JSON.parse(fs.readFileSync(channelFile, "utf8")) : null;
        if (identity?.testIdentity !== true || identity.channel !== channel) throw new Error("refusing to uninstall an unverified test identity");
        const result = spawnSync(uninstaller, ["/S"], { windowsHide: true, timeout: 60_000 });
        if (result.status !== 0) throw new Error("test uninstaller failed");
        const deadline = Date.now() + 60_000;
        while (fs.existsSync(path.join(location, `${meta.executableName}.exe`)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (fs.existsSync(path.join(location, `${meta.executableName}.exe`))) throw new Error("test uninstaller did not finish");
      }
      if (!/^\{?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?$/i.test(entry.Key)) throw new Error("invalid test uninstall registry key");
      // These checked literal registry paths stay within the named test entry; no filesystem paths are passed to another shell.
      runPowershell(`if (Test-Path -LiteralPath '${UNINSTALL_KEY}\\${entry.Key}') { Remove-Item -LiteralPath '${UNINSTALL_KEY}\\${entry.Key}' -Recurse -Force -ErrorAction Stop }\nif (Test-Path -LiteralPath 'HKCU:\\Software\\${entry.Key}') { Remove-Item -LiteralPath 'HKCU:\\Software\\${entry.Key}' -Recurse -Force -ErrorAction Stop }`);
    }
    const shortcuts = [
      path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", `${meta.shortcutName}.lnk`),
      path.join(defaultDesktopDir(), `${meta.shortcutName}.lnk`),
    ];
    for (const shortcut of shortcuts) fs.rmSync(shortcut, { force: true });
  }
}

function defaultDesktopDir() {
  const fromPs = runPowershell("[Environment]::GetFolderPath('Desktop')");
  return fromPs || path.join(os.homedir(), "Desktop");
}

function hashLocation(value) {
  if (!value) return null;
  return createHash("sha256").update(path.resolve(value).toLowerCase()).digest("hex").slice(0, 16);
}

/**
 * Capture a snapshot of real installations (`MANGA` and `MANGA Dev`) without storing raw machine paths (计划 4.8).
 * Tracks registry uninstall entry, executable presence/size/mtime/version, Start Menu & Desktop shortcuts, and `%LOCALAPPDATA%` data directories.
 */
export function snapshotRealInstallations(options = {}) {
  const channels = options.channels ?? ["release", "development"];
  const localAppData = options.localAppDataDir ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const appDataRoaming = options.roamingAppDataDir ?? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const startMenuDir = options.startMenuDir ?? path.join(appDataRoaming, "Microsoft", "Windows", "Start Menu", "Programs");
  const desktopDir = options.desktopDir ?? defaultDesktopDir();
  const programsDir = options.programsDir ?? path.join(localAppData, "Programs");
  const entries = options.registryEntries ?? readRegistryInstallations();

  const snapshot = {};
  for (const channel of channels) {
    const meta = CHANNEL_INSTALL[channel];
    const entry = entries.find((item) => item.DisplayName === meta.productName) ?? null;
    const installDir = entry?.InstallLocation || path.join(programsDir, meta.dirName);
    const exePath = path.join(installDir, `${meta.executableName}.exe`);
    const exeStat = fs.existsSync(exePath) ? fs.statSync(exePath) : null;
    const buildJson = readBuildInfoIfPresent(path.join(installDir, "resources"));
    const appDataDir = path.join(localAppData, meta.dirName);
    snapshot[channel] = {
      channel,
      productName: meta.productName,
      uninstallEntry: entry
        ? {
            present: true,
            key: entry.Key || null,
            displayName: entry.DisplayName || null,
            displayVersion: entry.DisplayVersion || null,
            publisher: entry.Publisher || null,
            locationHash: hashLocation(entry.InstallLocation),
          }
        : {
            present: false,
            key: null,
            displayName: null,
            displayVersion: null,
            publisher: null,
            locationHash: null,
          },
      executable: exeStat
        ? {
            present: true,
            bytes: exeStat.size,
            mtimeMs: Math.trunc(exeStat.mtimeMs),
            version: buildJson?.version ?? (entry?.DisplayVersion || null),
          }
        : {
            present: false,
            bytes: null,
            mtimeMs: null,
            version: null,
          },
      shortcuts: {
        startMenu: fs.existsSync(path.join(startMenuDir, `${meta.shortcutName}.lnk`)),
        desktop: fs.existsSync(path.join(desktopDir, `${meta.shortcutName}.lnk`)),
      },
      dataDir: {
        appDataExists: fs.existsSync(appDataDir),
        sqliteExists: fs.existsSync(path.join(appDataDir, "data", "manga.sqlite")),
      },
      registry: options.registry ? options.registry(channel) : openWithSnapshot(channel),
    };
  }
  return snapshot;
}

/** A real identity's "Open with" registration and the extensions' default values, hashed so no machine path is kept. */
function openWithSnapshot(channel) {
  if (process.platform !== "win32") return { valuesHash: null, keys: null, extensionDefaults: null };
  const state = readOpenWithState(channel);
  return {
    valuesHash: createHash("sha256").update(JSON.stringify(state.values.map((value) => value.actual))).digest("hex").slice(0, 16),
    keys: Object.values(state.keys).map((present) => (present ? 1 : 0)).join(""),
    extensionDefaults: state.extensionDefaults,
  };
}

/**
 * Compare two snapshots from `snapshotRealInstallations()` and report any aspect of a real installation that changed (计划 4.8).
 */
export function compareRealInstallations(before, after, options = {}) {
  const channels = options.channels ?? Object.keys(before ?? {});
  const changes = [];
  for (const channel of channels) {
    const prev = before?.[channel];
    const next = after?.[channel];
    const label = `${channel} (${CHANNEL_INSTALL[channel]?.productName ?? channel})`;
    if (!prev || !next) {
      if (JSON.stringify(prev) !== JSON.stringify(next)) changes.push(`${label}: snapshot missing`);
      continue;
    }
    for (const section of ["uninstallEntry", "executable", "shortcuts", "dataDir", "registry"]) {
      const a = prev[section];
      const b = next[section];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        const diffKeys = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
        changes.push(`${label}: ${section} changed (${diffKeys.map((k) => `${k}: ${JSON.stringify(a?.[k])} -> ${JSON.stringify(b?.[k])}`).join(", ")})`);
      }
    }
  }
  return { ok: changes.length === 0, changes };
}
