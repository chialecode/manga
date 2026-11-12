/**
 * `@manga/app-core/light`: everything light open's main process may use (A-128). It reads files by path and serves them through `manga-media`
 * handles, without the library database, plugins, the Agent or updates. The dependency check (`scripts/check-deps.mjs`) keeps this entry and
 * what it imports free of those modules, and the package check looks at the bundle that comes out.
 */
export { MEDIA_SCHEME, MediaHandleTable, mediaUrl, parseMediaUrl } from "../media/handles.ts";
export { serveMedia } from "../media/serve.ts";
export { imageSizeOf, type ImageSize } from "./image-size.ts";
export { LIGHT_FINISHED_WITHIN_MS, LIGHT_POSITIONS_LIMIT, LightPositions, lightPageHash, videoFinished, type LightPosition, type StoredLightPosition } from "./positions.ts";
export {
  LIGHT_COMIC_EXTENSIONS, LIGHT_COMMANDS, LIGHT_COPY_BUDGET_BYTES, LIGHT_EXTRA_EXTENSIONS, LIGHT_IMAGE_EXTENSIONS, LIGHT_MODULE, LIGHT_VIDEO_EXTENSIONS,
  LightMediaService, lightFileKey, lightKindOf,
  type LightCommand, type LightKind, type LightMediaOptions, type LightOpened,
} from "./service.ts";
