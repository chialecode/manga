import { protocol } from "electron";
import { MEDIA_SCHEME, serveMedia, type MangaProductApp } from "@manga/app-core";

/**
 * `manga-media:` serves covers, comic pages, video, subtitles, fonts and recordings to the renderer. The URL carries only an
 * opaque handle the main process issued; the handle table decides what it stands for and whether it is still valid.
 * The scheme must be declared before the app is ready.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

export function handleMediaProtocol(getApp: () => MangaProductApp | undefined): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const app = getApp();
    if (!app) return new Response("service unavailable", { status: 503 });
    return serveMedia({ handles: app.media.handles, zips: app.media.zips }, {
      url: request.url,
      method: request.method,
      headers: request.headers,
      signal: request.signal,
    });
  });
}
