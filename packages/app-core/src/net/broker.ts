import net from "node:net";
import { MangaError } from "@manga/contracts";
import type { FetchLike } from "../metadata/bangumi.ts";
import { defaultLookup, isLocalHostname, isPrivateAddress, normalizeHostname } from "./address.ts";

export { isPrivateAddress } from "./address.ts";

export type BrokerOptions = {
  /** The host's network entry (Electron's `net.fetch`, so system proxies apply); defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Resolves a host name to its addresses; tests replace it, the default asks the system resolver. */
  lookup?: (host: string) => Promise<string[]>;
  /** Hosts that may be private or local: only what the person set up themselves, and test servers. Empty by default. */
  allowPrivate?: (host: string) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
};

export type FetchedText = { requestedUrl: string; finalUrl: string; status: number; contentType: string; text: string; bytes: number };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const TEXT_TYPES = ["text/html", "application/xhtml+xml", "text/plain"];

/**
 * The only way a page address given by the person is turned into a request (the network broker). Every hop of a redirect is checked again, a
 * host that is or resolves to a private address is refused, nothing is sent that identifies the person (no cookies, no credentials), and the
 * answer is bounded in time and size. The caller gets text, never a stream, and never the headers it was not meant to see.
 */
export class NetworkBroker {
  private readonly options: BrokerOptions;

  constructor(options: BrokerOptions = {}) {
    this.options = options;
  }

  /** Throws unless this address may be requested. */
  async check(raw: string): Promise<URL> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new MangaError("VALIDATION_ERROR", "that is not a web address", { details: { reason: "url" } }); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new MangaError("VALIDATION_ERROR", "only http and https addresses can be fetched", { details: { reason: "scheme" } });
    if (url.username || url.password) throw new MangaError("VALIDATION_ERROR", "an address with a login in it is not fetched", { details: { reason: "credentials" } });
    const host = normalizeHostname(url.hostname);
    if (!host) throw new MangaError("VALIDATION_ERROR", "that address has no host", { details: { reason: "url" } });
    if (this.options.allowPrivate?.(host)) return url;
    const denied = () => new MangaError("PATH_ESCAPE", "that address leads to this computer or its local network, which a page cannot be fetched from", { details: { reason: "private", host } });
    if (net.isIP(host)) { if (isPrivateAddress(host)) throw denied(); return url; }
    if (isLocalHostname(host)) throw denied();
    let addresses: string[] = [];
    try { addresses = await (this.options.lookup ?? defaultLookup)(host); } catch {
      // A name that cannot be resolved here may still be reachable through the system proxy; the request decides.
      addresses = [];
    }
    if (addresses.some((addr) => isPrivateAddress(addr))) throw denied();
    return url;
  }

  async fetchText(raw: string, signal?: AbortSignal): Promise<FetchedText> {
    const fetchIt = this.options.fetch ?? ((url, init) => fetch(url, init as RequestInit));
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const limit = this.options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let current = await this.check(raw);
    const first = current;
    for (let hop = 0; hop <= limit; hop += 1) {
      let response: Response;
      try {
        response = await fetchIt(current.toString(), {
          method: "GET", redirect: "manual", signal: combined,
          headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "user-agent": this.options.userAgent ?? "MANGA/1.0 (local reader)", "accept-language": "zh-CN,zh;q=0.9,en;q=0.6" },
        });
      } catch (error) {
        if (signal?.aborted) throw new MangaError("CANCELLED", "the fetch was cancelled");
        const timedOut = (error as { name?: string }).name === "TimeoutError" || timeout.aborted;
        throw new MangaError("PROVIDER_UNAVAILABLE", timedOut ? "the page took too long to answer" : "the page could not be reached", { retryable: true, details: { reason: timedOut ? "timeout" : "network" } });
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        const location = response.headers.get("location")!;
        void response.body?.cancel().catch(() => undefined);
        let next: URL;
        try { next = new URL(location, current); } catch { throw new MangaError("PROVIDER_UNAVAILABLE", "the page redirected somewhere that is not an address", { details: { reason: "redirect" } }); }
        const checked = await this.check(next.toString());
        if (current.protocol === "https:" && checked.protocol === "http:") throw new MangaError("PROVIDER_UNAVAILABLE", "the page redirected from a secure address to an insecure one", { details: { reason: "downgrade" } });
        current = checked;
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new MangaError("PROVIDER_UNAVAILABLE", `the page answered ${response.status}`, { retryable: response.status >= 500 || response.status === 429, details: { reason: "status", status: response.status } });
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const kind = contentType.split(";")[0]!.trim();
      if (kind && !TEXT_TYPES.includes(kind)) {
        void response.body?.cancel().catch(() => undefined);
        throw new MangaError("UNSUPPORTED_FORMAT", "that address is not a web page or text", { details: { reason: "contentType", contentType: kind } });
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw new MangaError("QUOTA_EXCEEDED", "the page is larger than can be kept", { details: { reason: "size", limit: maxBytes } });
      }
      const bytes = await readCapped(response, maxBytes, signal, timeout);
      return { requestedUrl: first.toString(), finalUrl: current.toString(), status: response.status, contentType: kind || "text/html", text: decode(bytes, contentType), bytes: bytes.length };
    }
    throw new MangaError("PROVIDER_UNAVAILABLE", "the page redirected too many times", { details: { reason: "redirects" } });
  }
}

async function readCapped(response: Response, maxBytes: number, callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): Promise<Uint8Array> {
  const tooBig = () => new MangaError("QUOTA_EXCEEDED", "the page is larger than can be kept", { details: { reason: "size", limit: maxBytes } });
  const abortedError = () => callerSignal?.aborted
    ? new MangaError("CANCELLED", "the fetch was cancelled")
    : new MangaError("PROVIDER_UNAVAILABLE", "the page took too long to answer", { retryable: true, details: { reason: "timeout" } });
  if (!response.body) {
    if (callerSignal?.aborted || timeoutSignal.aborted) throw abortedError();
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.length > maxBytes) throw tooBig();
    return all;
  }
  const reader = response.body.getReader();
  const combined = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  if (combined.aborted) onAbort();
  else combined.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      if (combined.aborted) throw abortedError();
      const { done, value } = await reader.read();
      if (combined.aborted) throw abortedError();
      if (done) {
        finished = true;
        break;
      }
      total += value.length;
      if (total > maxBytes) throw tooBig();
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MangaError) throw error;
    if (combined.aborted) throw abortedError();
    throw new MangaError("PROVIDER_UNAVAILABLE", "the page could not be read to the end", { retryable: true, details: { reason: "network" } });
  } finally {
    combined.removeEventListener("abort", onAbort);
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** The text of a response in the charset it declares (header first, then a `meta` near the top), UTF-8 when it declares none or one that is not known. */
function decode(bytes: Uint8Array, contentType: string): string {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const fromMeta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try { return new TextDecoder(label).decode(bytes); } catch { /* unknown label: try the next */ }
  }
  return new TextDecoder().decode(bytes);
}
