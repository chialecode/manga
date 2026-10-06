/**
 * What the app window may ask the system for, and which pages it may open outside the app. Kept free of Electron so the
 * decisions can be tested: the handlers in `index.ts` only pass the facts in and act on the answer.
 */

export type PermissionFacts = {
  permission: string;
  /** The page asking. */
  requestingUrl: string;
  /** For a media request: which devices (`audio`, `video`). */
  mediaTypes?: readonly string[];
  /** The page that is the app's own window. */
  appUrl: string;
  /** The request came from the app's main window, not from some other frame or window. */
  fromAppWindow: boolean;
};

const base = (url: string): string => url.split("#")[0]!.split("?")[0]!;

/** Whether a URL is the app's own page: the same document, or for the dev server the same origin. */
export function isAppPage(url: string, appUrl: string): boolean {
  if (!url) return false;
  try {
    const page = new URL(url);
    const app = new URL(appUrl);
    if (app.protocol === "file:") return page.protocol === "file:" && base(page.href) === base(app.href);
    return page.origin === app.origin;
  } catch {
    return false;
  }
}

/**
 * The microphone (audio only) and the list of installed fonts (for subtitle styles) are allowed, and only for the app's own
 * window. Camera, screen capture, notifications, geolocation and everything else are refused.
 */
export function permissionAllowed(facts: PermissionFacts): boolean {
  if (!facts.fromAppWindow || !isAppPage(facts.requestingUrl, facts.appUrl)) return false;
  if (facts.permission === "local-fonts") return true;
  if (facts.permission === "media") {
    const types = facts.mediaTypes ?? [];
    // A request that does not say what it wants is a request for everything: refuse it.
    return types.length > 0 && types.every((type) => type === "audio");
  }
  return false;
}

/** Pages the app opens in the system browser: the metadata source's own subject pages, over https, and nothing else. */
const EXTERNAL_HOSTS = new Set(["bgm.tv", "bangumi.tv", "chii.in"]);

export function externalUrlAllowed(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443") && EXTERNAL_HOSTS.has(url.hostname.toLowerCase()) && /^\/(subject|character|person)\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
