export { MangaProductApp, type ProductAppOptions } from "./product-app.ts";
export { AGENT_COMMANDS, AGENT_OPT_IN_COMMANDS, NOTE_CONTENT_COMMANDS, OWNER_COMMANDS } from "./commands/access.ts";
export { resolveLaunchLayout, persistPointer, defaultPointerPath, channelFolderName, type LaunchRequest } from "./locations.ts";
export { TestVault, UnavailableVault, ElectronSafeStorageVault, type CredentialVault } from "./credentials.ts";
export { GrantRegistry } from "./grants.ts";
export { exportLibraryPackage, exportLibraryPackageCancellable, importLibraryPackage, recoverOrRollback, previewLibraryPackage, importLibraryPackageResolved } from "./domain/library-package.ts";
export { parseDocument, parseDocumentBytes, parseEpubBytes, parseMobiBytes, parsePdfBytes, parseTextBytes, buildEpubFixture, buildMobiFixture, buildPdfFixture, buildPdfObjectStreamFixture, buildZip, readZip, palmdocDecompress, htmlToText, htmlImageSources, htmlSvgImageHrefs, sniffFormat } from "./domain/formats.ts";
export { applyNoteOp, coerceNoteDocument, notePlainText, uniqueBlockIds, isKnownBlockType } from "./domain/note-document.ts";
export { resolveTextLocator, findQuoteMatches } from "./domain/anchors.ts";
export { deriveShell, reduceHover, initialHover, defaultShell, clampSide, dragLimit, RAIL_WIDTH, TOP_ROW_HEIGHT, MAIN_FLOOR, SIDE_WIDTH } from "./domain/shell-layout.ts";
export type { ShellChrome, ShellViewport, OverlaySide, HoverState } from "./domain/shell-layout.ts";
export { builtinReaderEngine, type ReaderEngine, type ReaderEngineDocument, type ReaderEnginePart, type ReaderEngineTextRun } from "./domain/reader-engine.ts";
export { readShell } from "./reading-service.ts";
export { MediaServices } from "./media/services.ts";
export { ComicService } from "./comic/service.ts";
export { serveMedia, MEDIA_SCHEME } from "./media/index.ts";
export type { PluginChannel, PluginSpawner } from "./plugins/runtime.ts";
export { FIRST_PARTY_KEYS } from "./plugins/trust.ts";
export { loadVecExtension } from "./semantic/service.ts";
export { WorkFolders, safeName, type WorkFile, type WorkFolder, type WorkFileKind } from "./work-folders.ts";
export { ScreenshotService, embedPngText, readPngText, pngSize, type ScreenshotView } from "./screenshots.ts";
export { DandanClient, DANDAN_API_ORIGIN, type DandanClientOptions } from "./danmaku/client.ts";
export { dandanSignature, dandanHeaders, type DandanCredentials } from "./danmaku/sign.ts";
export { DanmakuService, cacheTtlMs, CACHE_TTL, REFRESH_MIN_MS } from "./danmaku/service.ts";
export { parseComments, sourceOf } from "./danmaku/parse.ts";
export {
  BUILD_JSON_NAME,
  BUILD_SCHEMA_VERSION,
  BuildInfoSchema,
  VERSION_LINE,
  computeDevVersion,
  computeNextReleaseVersion,
  createBuildInfo,
  formatUtcBuildTimestamp,
  readBuildInfo,
  readBuildInfoIfPresent,
  readGitShortCommit,
  readGitTags,
  resolveBuildVersion,
  writeBuildInfo,
  type BuildInfo,
} from "./version.ts";
export {
  RELEASE_UPDATE_PUBLIC_KEYS,
  UPDATE_SIGNATURE_FORMAT,
  ReleaseInstallerSignatureSchema,
  assertReleaseInstallerVerified,
  buildBlockMap,
  checkAppUpdateConfig,
  compareReleaseVersions,
  computeBlockMapPlan,
  formatLatestYaml,
  parseBlockMapBytes,
  parseLatestYaml,
  rawPublicKey,
  serializeBlockMapGzip,
  sha512BytesBase64,
  sha512FileBase64,
  signReleaseInstaller,
  updateSigningMessage,
  verifyReleaseInstaller,
  type BlockMapData,
  type DifferentialOperation,
  type LatestManifest,
  type ReleaseInstallerSignature,
  type VerifiedUpdateReceipt,
  type VerifyReleaseInstallerResult,
} from "./update/signature.ts";
export {
  DEFAULT_GITHUB_FEED_URL,
  DEFAULT_UPDATE_INITIAL_DELAY_MS,
  DEFAULT_UPDATE_INTERVAL_MS,
  UpdateService,
  type UpdateServiceOptions,
  type UpdateInstallerDownloader,
} from "./update/service.ts";
