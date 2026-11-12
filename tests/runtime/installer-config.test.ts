import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NsisUpdater } from "electron-updater";
import * as resedit from "resedit";
import { pngSize } from "@manga/app-core";
import {
  CHANNEL_INSTALL,
  DEFAULT_ICON_ICO,
  DEFAULT_ICON_PNG,
  DEFAULT_ICON_SVG,
  DEV_ICON_ICO,
  DEV_ICON_PNG,
  DEV_ICON_SVG,
  ICON_SIZES,
  INSTALLER_META,
  TEST_CHANNEL_INSTALL,
  appUpdateYaml,
  averageDown,
  checkAppUpdateConfig,
  channelIcons,
  checkInstallerConfig,
  compareRealInstallations,
  installMeta,
  installerConfig,
  installerInclude,
  inspectIco,
  OPEN_WITH_TYPES,
  openWithIdentity,
  openWithNsis,
  openWithValues,
  snapshotRealInstallations,
  writesExtensionDefault,
} from "../../scripts/stage/installer-lib.mjs";
import { LIGHT_COMIC_EXTENSIONS, LIGHT_IMAGE_EXTENSIONS, LIGHT_VIDEO_EXTENSIONS } from "@manga/app-core/light";

// AT-150 / AT-160 / AT-162 / 计划 4.6, 4.8, 4.10: per user, no elevation, the folder can be changed and defaults to manga / manga-dev under
// %LOCALAPPDATA%\Programs, uninstalling keeps the data, Simplified Chinese UI, application icons, publisher/description/copyright metadata,
// app-update.yml publisherName enforcement, test installation identities, and real-installation snapshots.

const tempDirs: string[] = [];
const makeTemp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-inst-cfg-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const make = (channel: "release" | "development", testIdentity = false) =>
  installerConfig(channel, { output: "out", include: "x.nsh", version: "0.1.1", testIdentity });

describe("the per-user installer's configuration (AT-150, AT-162)", () => {
  it("is right for both channels and includes Chinese NSIS settings, publisher metadata and icons", () => {
    for (const channel of ["release", "development"] as const) {
      const config = make(channel);
      expect(checkInstallerConfig(channel, config, installerInclude(channel))).toEqual([]);
      expect(config.nsis).toMatchObject({
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        deleteAppDataOnUninstall: false,
        runAfterFinish: true,
        language: "2052",
        installerLanguages: ["zh_CN"],
        installerIcon: channelIcons(channel).ico,
        uninstallerIcon: channelIcons(channel).ico,
        installerHeaderIcon: channelIcons(channel).ico,
      });
      expect(config.win).toMatchObject({
        icon: channelIcons(channel).ico,
        signtoolOptions: {
          publisherName: ["chialecode"],
        },
        signAndEditExecutable: false,
      });
      expect(config.copyright).toBe(INSTALLER_META.copyright);
      expect(config.extraMetadata).toMatchObject({
        description: INSTALLER_META.description,
        author: { name: INSTALLER_META.author },
        homepage: INSTALLER_META.homepage,
      });
      expect(config.publish).toBeNull();
    }
    expect(installerInclude("release")).toContain("$LOCALAPPDATA\\Programs\\manga\"");
    expect(installerInclude("development")).toContain("$LOCALAPPDATA\\Programs\\manga-dev\"");
    // An earlier installation's folder and /D= win over the default.
    expect(installerInclude("release")).toMatch(/InstallLocation[\s\S]*GetDParameter[\s\S]*\$\{If\} \$R1 == ""[\s\S]*\$\{AndIf\} \$R0 == ""/);
  });

  it("makes the shortcuts itself: both optional in the wizard, both on a silent first install, only dev's desktop one again on a silent over-install", () => {
    for (const channel of ["release", "development"] as const) {
      const config = make(channel);
      const include = installerInclude(channel);
      expect(config.nsis).toMatchObject({ createDesktopShortcut: false, createStartMenuShortcut: false });
      // Wizard: a page with both boxes, skipped on updates; they start checked on a first install, otherwise as the shortcuts are.
      expect(include).toContain("创建开始菜单快捷方式");
      expect(include).toContain("创建桌面快捷方式");
      expect(include).toMatch(/Function MangaShortcutsPage\r\n {4}\$\{if\} \$\{isUpdated\}\r\n {6}Abort/);
      expect(include).toMatch(/StrCpy \$MangaWantStartMenu \$MangaHadStartMenu\r\n {2}StrCpy \$MangaWantDesktop \$MangaHadDesktop\r\n {2}\$\{if\} \$MangaFirstInstall == "1"\r\n {4}StrCpy \$MangaWantStartMenu "1"\r\n {4}StrCpy \$MangaWantDesktop "1"/);
      // Before anything changes: installed or not, and which shortcuts exist.
      expect(include).toMatch(/!macro customInit[\s\S]*!insertmacro MangaShortcutsInit\r\n!macroend/);
      expect(include).toMatch(/ReadRegStr \$R2 HKCU "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/);
      // Silent or updated: keep what is there, both on a first install; only the development channel forces the desktop shortcut.
      expect(include).toMatch(/\$\{if\} \$\{Silent\}\r\n {2}\$\{orIf\} \$\{isUpdated\}\r\n[^\r]*\r\n {4}StrCpy \$R8 \$MangaHadStartMenu\r\n {4}StrCpy \$R9 \$MangaHadDesktop\r\n {4}\$\{if\} \$MangaFirstInstall == "1"\r\n {6}StrCpy \$R8 "1"\r\n {6}StrCpy \$R9 "1"/);
      expect(include).toMatch(/!ifdef MANGA_DESKTOP_ON_UPDATE\r\n {6}StrCpy \$R9 "1"\r\n {4}!endif/);
      expect(include.includes("!define MANGA_DESKTOP_ON_UPDATE")).toBe(channel === "development");
      expect(include).toMatch(/!macro customInstall\r\n {2}!insertmacro MangaShortcutsInstall/);
      expect(include).toMatch(/!macro customUnInstall\r\n {2}!insertmacro MangaShortcutsUninstall/);
      // Uninstall removes both, but not for an over-install or update (the old uninstaller always gets --updated).
      expect(include).toMatch(/!macro MangaShortcutsUninstall\r\n {2}\$\{ifNot\} \$\{isUpdated\}\r\n {4}WinShell::UninstShortcut "\$SMPROGRAMS\\\$\{SHORTCUT_NAME\}\.lnk"[\s\S]*Delete "\$DESKTOP\\\$\{SHORTCUT_NAME\}\.lnk"\r\n {2}\$\{endIf\}/);
      expect(checkInstallerConfig(channel, config, include)).toEqual([]);
      expect(checkInstallerConfig(channel, { ...config, nsis: { ...config.nsis, createStartMenuShortcut: true } }, include)).toEqual(["shortcuts not the include's"]);
      expect(checkInstallerConfig(channel, { ...config, nsis: { ...config.nsis, createDesktopShortcut: true } }, include)).toEqual(["shortcuts not the include's"]);
      expect(checkInstallerConfig(channel, config, include.replace("  !insertmacro MangaShortcutsInstall", ""))).toEqual(["shortcuts not the include's"]);
    }
    // A release include does not make the development channel's desktop shortcut again.
    const dev = make("development");
    expect(checkInstallerConfig("development", dev, installerInclude("release"))).toContain("shortcuts not the include's");
  });

  it("keeps the two channels apart in what Windows tells apart", () => {
    const release = CHANNEL_INSTALL.release;
    const development = CHANNEL_INSTALL.development;
    for (const field of ["appId", "productName", "executableName", "dirName", "shortcutName"] as const) expect(release[field]).not.toBe(development[field]);
    expect([release.shortcutName, development.shortcutName]).toEqual(["MANGA", "MANGA Dev"]);
  });

  it("names what is wrong in a configuration that would not do", () => {
    const config = make("release");
    expect(checkInstallerConfig("release", { ...config, nsis: { ...config.nsis, perMachine: true } }, installerInclude("release"))).toEqual(["not per user"]);
    expect(checkInstallerConfig("release", { ...config, nsis: { ...config.nsis, deleteAppDataOnUninstall: true } }, installerInclude("release"))).toEqual(["uninstall deletes data"]);
    expect(checkInstallerConfig("release", { ...config, nsis: { ...config.nsis, oneClick: true, allowElevation: true } }, installerInclude("release"))).toEqual(["one-click", "asks for elevation"]);
    expect(checkInstallerConfig("release", config, installerInclude("development"))).toEqual(["default folder", "\"Open with\" registration missing or different"]);
    expect(checkInstallerConfig("development", config, installerInclude("development"))).toEqual(["appId app.manga.desktop", "productName MANGA", "not the channel's icon"]);
    expect(checkInstallerConfig("release", { ...config, nsis: { ...config.nsis, language: "1033", installerLanguages: ["en_US"] } }, installerInclude("release"))).toEqual(["not Simplified Chinese (zh_CN / 2052)"]);
    expect(checkInstallerConfig("release", { ...config, win: { ...config.win, icon: "" } }, installerInclude("release"))).toEqual(["missing icon"]);
    expect(checkInstallerConfig("release", { ...config, nsis: { ...config.nsis, installerIcon: DEV_ICON_ICO } }, installerInclude("release"))).toEqual(["not the channel's icon"]);
    expect(checkInstallerConfig("release", { ...config, extraMetadata: { ...config.extraMetadata, author: { name: "" } } }, installerInclude("release"))).toEqual(["missing author"]);
  });

  it("registers \"Open with\" by its own ProgIDs, never by file associations or an extension's default value (AT-166, 4.5)", () => {
    expect(OPEN_WITH_TYPES.video).toEqual([...LIGHT_VIDEO_EXTENSIONS].sort());
    expect(OPEN_WITH_TYPES.comic).toEqual(LIGHT_COMIC_EXTENSIONS);
    expect([...OPEN_WITH_TYPES.image].sort()).toEqual([...LIGHT_IMAGE_EXTENSIONS].sort());
    expect(OPEN_WITH_TYPES.video).toHaveLength(13);
    const ids = [
      openWithIdentity("release"), openWithIdentity("development"),
      openWithIdentity("release", { testIdentity: true }), openWithIdentity("development", { testIdentity: true }),
    ];
    expect(ids.map((id) => id.progIds.video)).toEqual(["MANGA.Video", "MANGA.Dev.Video", "MANGA.Test.Video", "MANGA.DevTest.Video"]);
    expect(ids.map((id) => id.progIds.comic)).toEqual(["MANGA.Comic", "MANGA.Dev.Comic", "MANGA.Test.Comic", "MANGA.DevTest.Comic"]);
    expect(ids.map((id) => id.progIds.image)).toEqual(["MANGA.Image", "MANGA.Dev.Image", "MANGA.Test.Image", "MANGA.DevTest.Image"]);
    // No identity shares a name with another, so a test identity never touches the real one it stands for.
    const names = (id: (typeof ids)[number]) => [...Object.values(id.progIds), id.exe, id.capabilitiesRoot, id.registeredName];
    for (const [a, b] of [[0, 2], [1, 3], [0, 1], [2, 3]] as const) for (const name of names(ids[a]!)) expect(names(ids[b]!)).not.toContain(name);

    const values = openWithValues("release");
    const command = values.find(([key]) => key === "Software\\Classes\\MANGA.Video\\shell\\open\\command");
    expect(command?.[2]).toBe('"$INSTDIR\\manga.exe" --manga-light "%1"');
    expect(values).toContainEqual(["Software\\Classes\\.mp4\\OpenWithProgids", "MANGA.Video", ""]);
    expect(values).toContainEqual(["Software\\Classes\\.cbz\\OpenWithProgids", "MANGA.Comic", ""]);
    expect(values).toContainEqual(["Software\\Classes\\Applications\\manga.exe", "FriendlyAppName", "MANGA"]);
    expect(values).toContainEqual(["Software\\Classes\\Applications\\manga.exe\\SupportedTypes", ".webp", ""]);
    expect(values).toContainEqual(["Software\\MANGA\\Release\\Capabilities\\FileAssociations", ".jpg", "MANGA.Image"]);
    expect(values).toContainEqual(["Software\\RegisteredApplications", "MANGA", "Software\\MANGA\\Release\\Capabilities"]);
    // No value is written on an extension key itself, and .zip is never registered.
    expect(values.filter(([key]) => /^Software\\Classes\\\.[^\\]+$/.test(key))).toEqual([]);
    expect(values.some(([key]) => key.includes(".zip"))).toBe(false);

    const nsis = openWithNsis("release").join("\n");
    expect(writesExtensionDefault(nsis)).toBe(false);
    expect(nsis).toContain("SHChangeNotify(i 0x08000000");
    // Uninstalling removes MANGA's own value from OpenWithProgids and deletes an extension key only when nothing is left in it.
    expect(nsis).toContain('DeleteRegValue HKCU "Software\\Classes\\.mkv\\OpenWithProgids" "MANGA.Video"');
    expect(nsis).toContain('!insertmacro MangaDeleteBareKey "Software\\Classes\\.mkv"');
    expect(nsis).not.toMatch(/DeleteRegKey(?: \/ifempty)? HKCU "Software\\Classes\\\./);
    expect(nsis).toContain('DeleteRegKey HKCU "Software\\MANGA\\Release"');

    const config = make("release");
    expect(checkInstallerConfig("release", { ...config, fileAssociations: [{ ext: "mp4", name: "Video" }] }, installerInclude("release"))).toEqual(["fileAssociations is set"]);
    expect(checkInstallerConfig("release", config, `${installerInclude("release")}\r\n  WriteRegStr HKCU "Software\\Classes\\.mp4" "" "MANGA.Video"`)).toEqual(["writes an extension's default value"]);
    expect(checkInstallerConfig("release", config, installerInclude("release").replace(/^.*MANGA\.Image\\shell.*$/m, ""))).toEqual(["\"Open with\" registration missing or different"]);
    expect(writesExtensionDefault('WriteRegStr HKCR ".cbz" "" "MANGA.Comic"')).toBe(true);
    expect(writesExtensionDefault('WriteRegStr HKCU "Software\\Classes\\.cbz\\OpenWithProgids" "MANGA.Comic" ""')).toBe(false);
  });

  it("ships a valid SVG source, a 512x512 PNG, and a multi-resolution Windows ICO with 16..256 px frames (AT-162)", () => {
    expect(fs.existsSync(DEFAULT_ICON_SVG)).toBe(true);
    expect(fs.existsSync(DEFAULT_ICON_PNG)).toBe(true);
    expect(fs.existsSync(DEFAULT_ICON_ICO)).toBe(true);

    const svgText = fs.readFileSync(DEFAULT_ICON_SVG, "utf8");
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("#3C4043");
    expect(svgText).not.toContain("#F3A115");

    const pngBytes = fs.readFileSync(DEFAULT_ICON_PNG);
    expect(pngSize(pngBytes)).toEqual({ width: 512, height: 512 });

    const icoBytes = fs.readFileSync(DEFAULT_ICON_ICO);
    const inspected = inspectIco(icoBytes);
    expect(inspected).toEqual({
      valid: true,
      count: ICON_SIZES.length,
      sizes: ICON_SIZES,
      problems: [],
    });
    const parsedByResedit = resedit.Data.IconFile.from(icoBytes);
    expect(parsedByResedit.icons).toHaveLength(ICON_SIZES.length);
  });

  it("gives the development channel its own icon: the mark on dark gray with an amber \"DEV\" badge, in the same sizes (AT-162)", () => {
    expect(channelIcons("release")).toEqual({ svg: DEFAULT_ICON_SVG, png: DEFAULT_ICON_PNG, ico: DEFAULT_ICON_ICO });
    expect(channelIcons("development")).toEqual({ svg: DEV_ICON_SVG, png: DEV_ICON_PNG, ico: DEV_ICON_ICO });
    const svgText = fs.readFileSync(DEV_ICON_SVG, "utf8");
    expect(svgText).toContain("#3C4043");
    expect(svgText).toContain("#F3A115");
    expect(pngSize(fs.readFileSync(DEV_ICON_PNG))).toEqual({ width: 512, height: 512 });
    const icoBytes = fs.readFileSync(DEV_ICON_ICO);
    expect(inspectIco(icoBytes)).toEqual({ valid: true, count: ICON_SIZES.length, sizes: ICON_SIZES, problems: [] });
    expect(icoBytes.equals(fs.readFileSync(DEFAULT_ICON_ICO))).toBe(false);
  });

  it("draws every icon size by averaging one 1024 px render, so small sizes keep the strokes' weight", () => {
    // A 4x4 master, left half opaque white, right half transparent: halving keeps the edge, quartering blends it by area.
    const master = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) master.set([255, 255, 255, 255], (y * 4 + x) * 4);
    expect([...averageDown(master, 4, 2)]).toEqual([255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0]);
    // Transparent pixels do not darken the colour, only lower the coverage.
    expect([...averageDown(master, 4, 1)]).toEqual([255, 255, 255, 128]);
  });

  it("requires publisherName in app-update.yml so electron-updater calls verifyUpdateCodeSignature, and fails when publisherName is removed (AT-160, 计划 3.1)", async () => {
    const validYaml = appUpdateYaml();
    expect(checkAppUpdateConfig(validYaml)).toEqual([]);
    expect(checkInstallerConfig("release", make("release"), installerInclude("release"), { appUpdateText: validYaml })).toEqual([]);

    // Removing publisherName must fail the configuration check.
    const withoutPublisher = appUpdateYaml({ publisherName: [] });
    expect(withoutPublisher).not.toContain("publisherName");
    expect(checkAppUpdateConfig(withoutPublisher)).toContain("missing publisherName chialecode");
    expect(checkInstallerConfig("release", make("release"), installerInclude("release"), { appUpdateText: withoutPublisher })).toContain("missing publisherName chialecode");

    // Prove on NsisUpdater itself why publisherName is mandatory: without it verifySignature returns null without calling verifyUpdateCodeSignature;
    // with publisherName: ["chialecode"], verifySignature reads app-update.yml, invokes verifyUpdateCodeSignature and rejects when verification fails.
    const dir = makeTemp();
    const fakeInstallerFile = path.join(dir, "manga-setup-0.1.2.exe");
    const makeUpdater = (yamlContent: string) => {
      const configFile = path.join(dir, `app-update-${Math.random().toString(36).slice(2)}.yml`);
      fs.writeFileSync(configFile, yamlContent);
      return new NsisUpdater(
        { provider: "github", owner: "chialecode", repo: "manga" },
        {
          version: "0.1.1",
          name: "manga",
          isPackaged: true,
          appUpdateConfigPath: configFile,
          userDataPath: path.join(dir, "userData"),
          baseCachePath: path.join(dir, "cache"),
          whenReady: () => Promise.resolve(),
          relaunch: () => undefined,
          quit: () => undefined,
          onQuit: () => undefined,
        },
      );
    };

    const calls: Array<{ publishers: string[]; file: string }> = [];
    const updaterWithoutPublisher = makeUpdater(withoutPublisher);
    updaterWithoutPublisher.verifyUpdateCodeSignature = async (publisherNames: string[], file: string) => {
      calls.push({ publishers: publisherNames, file });
      return "Ed25519 signature mismatch";
    };
    const runVerify = (instance: NsisUpdater) =>
      (instance as unknown as { verifySignature(tempUpdateFile: string): Promise<string | null> }).verifySignature(fakeInstallerFile);
    expect(await runVerify(updaterWithoutPublisher)).toBeNull();
    expect(calls).toHaveLength(0);

    const updaterWithPublisher = makeUpdater(validYaml);
    updaterWithPublisher.verifyUpdateCodeSignature = async (publisherNames: string[], file: string) => {
      calls.push({ publishers: publisherNames, file });
      return "Ed25519 signature mismatch";
    };
    expect(await runVerify(updaterWithPublisher)).toBe("Ed25519 signature mismatch");
    expect(calls).toEqual([{ publishers: ["chialecode"], file: fakeInstallerFile }]);
  });

  it("defines distinct test installation identities for both channels and detects any modification to real installations (计划 4.8)", () => {
    for (const channel of ["release", "development"] as const) {
      const real = installMeta(channel, { testIdentity: false });
      const test = installMeta(channel, { testIdentity: true });
      expect(test).toBe(TEST_CHANNEL_INSTALL[channel]);
      for (const field of ["appId", "productName", "executableName", "dirName", "shortcutName"] as const) {
        expect(test[field]).not.toBe(real[field]);
      }
      const config = make(channel, true);
      expect(checkInstallerConfig(channel, config, installerInclude(channel, { testIdentity: true }), { testIdentity: true })).toEqual([]);
      expect(installerInclude(channel, { testIdentity: true })).toContain(`$LOCALAPPDATA\\Programs\\${test.dirName}"`);
    }
    expect(TEST_CHANNEL_INSTALL.release.productName).toBe("MANGA Test");
    expect(TEST_CHANNEL_INSTALL.development.productName).toBe("MANGA Dev Test");

    // Snapshot & compare real installations in an isolated directory layout.
    const root = makeTemp();
    const localAppDataDir = path.join(root, "Local");
    const programsDir = path.join(localAppDataDir, "Programs");
    const startMenuDir = path.join(root, "StartMenu");
    const desktopDir = path.join(root, "Desktop");
    fs.mkdirSync(path.join(programsDir, "manga", "resources"), { recursive: true });
    fs.writeFileSync(path.join(programsDir, "manga", "manga.exe"), "real-release-binary");
    fs.writeFileSync(
      path.join(programsDir, "manga", "resources", "build.json"),
      JSON.stringify({ version: "0.1.1", channel: "release", commit: "1234567", builtAt: "2026-11-08T00:00:00.000Z", schemaVersion: 14 }),
    );
    fs.mkdirSync(path.join(localAppDataDir, "manga", "data"), { recursive: true });
    fs.writeFileSync(path.join(localAppDataDir, "manga", "data", "manga.sqlite"), "sqlite");
    fs.mkdirSync(startMenuDir, { recursive: true });
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(path.join(startMenuDir, "MANGA.lnk"), "lnk");
    fs.writeFileSync(path.join(desktopDir, "MANGA.lnk"), "lnk");

    const registryEntries = [
      {
        Key: "real-release-guid",
        DisplayName: "MANGA",
        DisplayVersion: "0.1.1",
        Publisher: "chialecode",
        InstallLocation: path.join(programsDir, "manga"),
        UninstallString: `"${path.join(programsDir, "manga", "Uninstall MANGA.exe")}" /currentuser`,
      },
    ];

    const before = snapshotRealInstallations({
      localAppDataDir,
      programsDir,
      startMenuDir,
      desktopDir,
      registryEntries,
    });
    expect(before.release.executable).toMatchObject({ present: true, version: "0.1.1" });
    expect(before.release.shortcuts).toEqual({ startMenu: true, desktop: true });
    expect(before.release.dataDir).toEqual({ appDataExists: true, sqliteExists: true });
    expect(before.development.uninstallEntry.present).toBe(false);
    expect(compareRealInstallations(before, before)).toEqual({ ok: true, changes: [] });

    // Modifying the real executable, shortcut, registry entry or data folder is detected and named.
    fs.writeFileSync(path.join(programsDir, "manga", "manga.exe"), "tampered-real-release-binary");
    fs.rmSync(path.join(desktopDir, "MANGA.lnk"));
    const after = snapshotRealInstallations({
      localAppDataDir,
      programsDir,
      startMenuDir,
      desktopDir,
      registryEntries,
    });
    const diff = compareRealInstallations(before, after);
    expect(diff.ok).toBe(false);
    expect(diff.changes.some((line: string) => line.includes("release (MANGA): executable changed"))).toBe(true);
    expect(diff.changes.some((line: string) => line.includes("release (MANGA): shortcuts changed"))).toBe(true);
  });
});
