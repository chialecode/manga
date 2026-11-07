import type { DandanCredentials } from "@manga/app-core";

// Filled in by the build of the main process (see danmaku-define.ts); not defined anywhere else, so a run from source has none.
declare const __MANGA_DANDANPLAY_APP_ID__: string | undefined;
declare const __MANGA_DANDANPLAY_APP_SECRET__: string | undefined;

/** The application credentials built into this release, or `null` when the build had none. They are used only here in the main process, to sign requests. */
export function builtInDanmakuCredentials(): DandanCredentials | null {
  const appId = typeof __MANGA_DANDANPLAY_APP_ID__ === "string" ? __MANGA_DANDANPLAY_APP_ID__ : "";
  const secret = typeof __MANGA_DANDANPLAY_APP_SECRET__ === "string" ? __MANGA_DANDANPLAY_APP_SECRET__ : "";
  return appId && secret ? { appId, secret } : null;
}

/** What a smoke run uses instead: a smoke run never signs with the credentials of a release, and reaches only the address the harness gives it. */
export const SMOKE_DANMAKU_CREDENTIALS: DandanCredentials = { appId: "smokeapp01", secret: "smoke-secret-for-the-local-fake-server" };
