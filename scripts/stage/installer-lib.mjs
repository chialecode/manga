import fs from "node:fs";
import path from "node:path";

/**
 * The per-user installer (A-119, 计划 4.10): electron-builder's NSIS target over the directory Forge packaged (`--prepackaged`). No administrator rights,
 * the folder can be changed, the default is `%LOCALAPPDATA%\Programs\manga` (development: `manga-dev`), and uninstalling removes the program, its
 * shortcuts and its uninstall entry only: the data (A-118) and the person's files stay. The two channels differ in everything Windows tells apart, so
 * both can be installed at once. Unsigned: no certificate is configured.
 */
export const CHANNEL_INSTALL = {
  release: { appId: "app.manga.desktop", productName: "MANGA", executableName: "MANGA", dirName: "manga", shortcutName: "MANGA" },
  development: { appId: "app.manga.desktop.dev", productName: "MANGA Dev", executableName: "MANGA-dev", dirName: "manga-dev", shortcutName: "MANGA Dev" },
};

/** The NSIS lines electron-builder includes: the default folder named for the channel unless an earlier installation or `/D=` chose another. */
export function installerInclude(channel) {
  const { dirName } = CHANNEL_INSTALL[channel];
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
  ].join("\r\n");
}

/** The electron-builder configuration of one channel; `checkInstallerConfig` reads the same fields back. */
export function installerConfig(channel, { output, include, version }) {
  const meta = CHANNEL_INSTALL[channel];
  return {
    appId: meta.appId,
    productName: meta.productName,
    executableName: meta.executableName,
    extraMetadata: { version },
    directories: { output },
    win: { target: [{ target: "nsis", arch: ["x64"] }], signAndEditExecutable: false },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: meta.shortcutName,
      uninstallDisplayName: meta.productName,
      include,
      artifactName: `${meta.dirName}-setup-\${version}.\${ext}`,
    },
    publish: null,
  };
}

/** What the installer must be (计划 4.10); a list of problems, empty when it is right. */
export function checkInstallerConfig(channel, config, includeText) {
  const meta = CHANNEL_INSTALL[channel];
  const problems = [];
  if (config.appId !== meta.appId) problems.push(`appId ${config.appId}`);
  if (config.productName !== meta.productName) problems.push(`productName ${config.productName}`);
  if (config.nsis?.perMachine !== false) problems.push("not per user");
  if (config.nsis?.oneClick !== false) problems.push("one-click");
  if (config.nsis?.allowElevation !== false) problems.push("asks for elevation");
  if (config.nsis?.allowToChangeInstallationDirectory !== true) problems.push("folder cannot be changed");
  if (config.nsis?.deleteAppDataOnUninstall !== false) problems.push("uninstall deletes data");
  if (!includeText.includes(`$LOCALAPPDATA\\Programs\\${meta.dirName}"`)) problems.push("default folder");
  return problems;
}

/**
 * Make the installer of one channel from a packaged directory. The channel is written into the copy it installs (as the package does), and the
 * executable carries the channel's name so the two installations, and the check that the program is not running, tell each other apart.
 */
export async function buildInstaller({ appDir, channel, workDir, version }) {
  const meta = CHANNEL_INSTALL[channel];
  const staged = path.join(workDir, `app-${channel}`);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.cpSync(appDir, staged, { recursive: true });
  fs.writeFileSync(path.join(staged, "resources", "channel.json"), `${JSON.stringify({ channel })}\n`);
  if (meta.executableName !== "MANGA") fs.renameSync(path.join(staged, "MANGA.exe"), path.join(staged, `${meta.executableName}.exe`));
  const include = path.join(workDir, `installer-${channel}.nsh`);
  fs.writeFileSync(include, installerInclude(channel));
  const output = path.join(workDir, `out-${channel}`);
  const config = installerConfig(channel, { output, include, version });
  const problems = checkInstallerConfig(channel, config, fs.readFileSync(include, "utf8"));
  if (problems.length) throw new Error(`installer configuration of ${channel}: ${problems.join(", ")}`);
  const { build, Platform, Arch } = await import("electron-builder");
  const started = Date.now();
  const made = await build({ targets: Platform.WINDOWS.createTarget("nsis", Arch.x64), prepackaged: staged, config, publish: "never" });
  const installer = made.find((file) => file.endsWith(".exe"));
  if (!installer) throw new Error("electron-builder made no installer");
  fs.rmSync(staged, { recursive: true, force: true });
  return { installer, bytes: fs.statSync(installer).size, ms: Date.now() - started, config };
}
