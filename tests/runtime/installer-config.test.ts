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
  ICON_SIZES,
  INSTALLER_META,
  TEST_CHANNEL_INSTALL,
  appUpdateYaml,
  checkAppUpdateConfig,
  checkInstallerConfig,
  compareRealInstallations,
  installMeta,
  installerConfig,
  installerInclude,
  inspectIco,
  snapshotRealInstallations,
} from "../../scripts/stage/installer-lib.mjs";

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
        installerIcon: DEFAULT_ICON_ICO,
        uninstallerIcon: DEFAULT_ICON_ICO,
        installerHeaderIcon: DEFAULT_ICON_ICO,
      });
      expect(config.win).toMatchObject({
        icon: DEFAULT_ICON_ICO,
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
    expect(checkInstallerConfig("release", config, installerInclude("development"))).toEqual(["default folder"]);
    expect(checkInstallerConfig("development", config, installerInclude("development"))).toEqual(["appId app.manga.desktop", "productName MANGA"]);
    expect(checkInstallerConfig("release", { ...config, nsis: { ...config.nsis, language: "1033", installerLanguages: ["en_US"] } }, installerInclude("release"))).toEqual(["not Simplified Chinese (zh_CN / 2052)"]);
    expect(checkInstallerConfig("release", { ...config, win: { ...config.win, icon: "" } }, installerInclude("release"))).toEqual(["missing icon"]);
    expect(checkInstallerConfig("release", { ...config, extraMetadata: { ...config.extraMetadata, author: { name: "" } } }, installerInclude("release"))).toEqual(["missing author"]);
  });

  it("ships a valid SVG source, a 512x512 PNG, and a multi-resolution Windows ICO with 16..256 px frames (AT-162)", () => {
    expect(fs.existsSync(DEFAULT_ICON_SVG)).toBe(true);
    expect(fs.existsSync(DEFAULT_ICON_PNG)).toBe(true);
    expect(fs.existsSync(DEFAULT_ICON_ICO)).toBe(true);

    const svgText = fs.readFileSync(DEFAULT_ICON_SVG, "utf8");
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("#AD3268");

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
