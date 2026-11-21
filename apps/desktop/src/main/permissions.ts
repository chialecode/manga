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

import fs from "node:fs";
import { fileURLToPath } from "node:url";

const base = (url: string): string => url.split("#")[0]!.split("?")[0]!;

const canonical = new Map<string, string>();
/**
 * One spelling for a page's file. Started through a short (8.3) name, the app builds its own page address from that spelling while the page
 * reports its long one; both name the same file, so they are compared as the file's real path (and without case on Windows).
 */
function samePageFile(href: string): string {
  const known = canonical.get(href);
  if (known !== undefined) return known;
  let file: string;
  try { file = fileURLToPath(href); } catch { file = href; }
  try { file = fs.realpathSync.native(file); } catch { /* not there: compare as written */ }
  if (process.platform === "win32") file = file.toLowerCase();
  if (canonical.size > 64) canonical.clear();
  canonical.set(href, file);
  return file;
}

/** Whether a URL is the app's own page: the same document, or for the dev server the same origin. */
export function isAppPage(url: string, appUrl: string): boolean {
  if (!url) return false;
  try {
    const page = new URL(url);
    const app = new URL(appUrl);
    if (app.protocol === "file:") return page.protocol === "file:" && (base(page.href) === base(app.href) || samePageFile(base(page.href)) === samePageFile(base(app.href)));
    return page.origin === app.origin;
  } catch {
    return false;
  }
}

/**
 * The microphone (audio only), the list of installed fonts (for subtitle styles), full screen (the readers and the
 * player) and writing text to the clipboard (the "copy" buttons of the record of a task and of the debug panel) are
 * allowed, and only for the app's own window. Reading the clipboard, camera, screen capture, notifications,
 * geolocation and everything else are refused. Full screen is a permission request in Electron: without it
 * `requestFullscreen()` is silently refused and the reader buttons do nothing; likewise `navigator.clipboard.writeText()`
 * fails with "Write permission denied" and the copy buttons only say that the copy failed.
 */
export function permissionAllowed(facts: PermissionFacts): boolean {
  if (!facts.fromAppWindow || !isAppPage(facts.requestingUrl, facts.appUrl)) return false;
  if (facts.permission === "local-fonts" || facts.permission === "fullscreen" || facts.permission === "clipboard-sanitized-write") return true;
  if (facts.permission === "media") {
    const types = facts.mediaTypes ?? [];
    // A request that does not say what it wants is a request for everything: refuse it.
    return types.length > 0 && types.every((type) => type === "audio");
  }
  return false;
}

/** The metadata source's hosts: on them, only the subject, character and person pages open. */
const EXTERNAL_HOSTS = new Set(["bgm.tv", "bangumi.tv", "chii.in"]);
/** Names that never lead to a public web page: this machine, a home or office network, or names reserved for tests and examples. */
const PRIVATE_SUFFIXES = ["localhost", "local", "lan", "home", "internal", "intranet", "corp", "test", "invalid", "example", "arpa"];

/**
 * Pages the app opens in the system browser, and nothing else: the metadata source's own subject pages, and ordinary web pages the app shows as links
 * (the sources of a web search, the results in the material search, a provider's key page, 计划 4.2/4.4/4.5). A web page is http or https on the default
 * port, without a user name or password, at a public host name: not an address, not this machine, not a single-label or reserved name.
 */
export function externalUrlAllowed(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (EXTERNAL_HOSTS.has(host)) return url.protocol === "https:" && (url.port === "" || url.port === "443") && /^\/(subject|character|person)\/\d+\/?$/.test(url.pathname);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.port !== "") return false;
    const labels = host.split(".");
    const tld = labels.at(-1) ?? "";
    // An IPv6 literal has brackets and an IPv4 one ends in digits; both are refused, as is a host without a dot.
    if (labels.length < 2 || !/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld) || host.includes("[")) return false;
    return !PRIVATE_SUFFIXES.includes(tld);
  } catch {
    return false;
  }
}
