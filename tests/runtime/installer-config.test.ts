import { describe, expect, it } from "vitest";
import { CHANNEL_INSTALL, checkInstallerConfig, installerConfig, installerInclude } from "../../scripts/stage/installer-lib.mjs";

// AT-150 / 计划 4.10, the configuration half (the real installation is `node scripts/stage.mjs installer`): per user, no elevation, the folder can be
// changed and defaults to manga / manga-dev under %LOCALAPPDATA%\Programs, uninstalling keeps the data, and the two channels differ in everything
// Windows tells apart.

const make = (channel: "release" | "development") => installerConfig(channel, { output: "out", include: "x.nsh", version: "0.1.0" });

describe("the per-user installer's configuration (AT-150)", () => {
  it("is right for both channels", () => {
    for (const channel of ["release", "development"] as const) {
      const config = make(channel);
      expect(checkInstallerConfig(channel, config, installerInclude(channel))).toEqual([]);
      expect(config.nsis).toMatchObject({ oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false });
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
  });
});
