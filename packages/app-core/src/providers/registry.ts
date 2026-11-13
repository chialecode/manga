import net from "node:net";
import { DEEPSEEK_HOST, MangaError, providerRef, type ProviderFile } from "@manga/contracts";
import type { ModelProfile } from "@manga/contracts/models";
import { defaultLookup, isLocalHostname, isPrivateAddress, normalizeHostname } from "../net/address.ts";
import type { PluginService } from "../plugins/service.ts";

/** True for IP literals, single-label names, and local/mDNS domain suffixes that are never public HTTPS provider hosts. */
function isPrivateProviderHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return !host || net.isIP(host) !== 0 || isLocalHostname(host);
}

/**
 * The providers the enabled provider plugins declare (PLUG-07, 计划 4.1), and the one gate every request on a provider's behalf goes through. A connection
 * added from a provider keeps working only while its plugin is enabled, trusted and unchanged: otherwise every call is refused before a request is made,
 * and what is under way is cancelled. Requests go only to the https hosts the provider file declares, never to a private address.
 */
export type ProviderEntry = {
  ref: string;
  pluginId: string;
  file: ProviderFile;
  /** Where requests go: the file's address, or the test origin. */
  baseUrl: string;
  hosts: string[];
};

export type ProviderRegistryOptions = {
  plugins: PluginService;
  /** Tests and the packaged walkthroughs only: every provider is served from this origin (the fake service on this machine). Never set in a product build. */
  testOrigin?: string;
  lookup?: (host: string) => Promise<string[]>;
};

/** The words for a connection whose provider is gone: the plugin is off, uninstalled, or no longer trusted (计划 4.1). */
export const providerUnavailable = (ref: string) => new MangaError("PROVIDER_UNAVAILABLE", "插件已停用：去插件页启用", { details: { reason: "plugin_disabled", provider: ref } });

export class ProviderRegistry {
  private readonly o: ProviderRegistryOptions;
  private readonly inflight = new Map<string, Set<AbortController>>();

  constructor(options: ProviderRegistryOptions) {
    this.o = options;
  }

  list(): ProviderEntry[] {
    return this.o.plugins.providerFilesEnabled().map(({ pluginId, file }) => {
      const test = this.o.testOrigin;
      return { ref: providerRef(pluginId, file.id), pluginId, file, baseUrl: test ?? file.baseUrl, hosts: test ? [...file.hosts, new URL(test).hostname] : file.hosts };
    });
  }

  get(ref: string): ProviderEntry | undefined {
    return this.list().find((entry) => entry.ref === ref);
  }

  require(ref: string): ProviderEntry {
    const entry = this.get(ref);
    if (!entry) throw providerUnavailable(ref);
    return entry;
  }

  /** Throws unless a request to this address may go out for the provider: a declared https domain (or the test origin), never a private or local host. */
  async checkAddress(entry: ProviderEntry, baseUrl: string): Promise<void> {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new MangaError("VALIDATION_ERROR", "the connection's address is not valid"); }
    if (url.username || url.password) throw new MangaError("VALIDATION_ERROR", "an address with a login in it is not fetched", { details: { reason: "credentials" } });
    const test = this.o.testOrigin ? new URL(this.o.testOrigin) : undefined;
    const isTest = Boolean(test && url.host === test.host);
    if (!entry.hosts.includes(url.hostname) || (url.protocol !== "https:" && !isTest)) {
      throw new MangaError("FORBIDDEN", "the address is not one the provider declares", { details: { reason: "provider_host", host: url.hostname } });
    }
    if (isTest) return;
    if (isPrivateProviderHost(url.hostname)) {
      throw new MangaError("FORBIDDEN", "private addresses are not allowed", { details: { reason: "private_address", host: url.hostname } });
    }
    let addresses: string[] = [];
    try { addresses = await (this.o.lookup ?? defaultLookup)(url.hostname); } catch {
      // A name that cannot be resolved locally may still be reachable through the system proxy; the request decides.
      addresses = [];
    }
    if (addresses.some((addr) => isPrivateAddress(addr, { allowTunnelRanges: true }))) {
      throw new MangaError("FORBIDDEN", "private addresses are not allowed", { details: { reason: "private_address", host: url.hostname } });
    }
  }

  /**
   * A signal for one call on a provider's behalf: aborted when the caller's is, and when the provider stops being available while the call is under way.
   * `release` must be called when the call is over.
   */
  track(ref: string, signal?: AbortSignal): { signal: AbortSignal; release: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    let set = this.inflight.get(ref);
    if (!set) this.inflight.set(ref, set = new Set());
    set.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        signal?.removeEventListener("abort", onAbort);
        set!.delete(controller);
        if (!set!.size) this.inflight.delete(ref);
      },
    };
  }

  /** After a plugin changed: what is under way for a provider that is no longer available is cancelled. Returns how many calls were cancelled. */
  cancelUnavailable(): number {
    const available = new Set(this.list().map((entry) => entry.ref));
    let cancelled = 0;
    for (const [ref, set] of this.inflight) {
      if (available.has(ref)) continue;
      for (const controller of set) { controller.abort(providerUnavailable(ref)); cancelled += 1; }
    }
    return cancelled;
  }
}

/** The dialect a connection speaks: the provider's (in its profile), or DeepSeek's for a connection added by hand to DeepSeek's address (as pi-ai detects it). */
export function dialectOf(profile: Pick<ModelProfile, "dialect">, baseUrl: string): "deepseek" | undefined {
  if (profile.dialect) return profile.dialect;
  try { return new URL(baseUrl).hostname === DEEPSEEK_HOST ? "deepseek" : undefined; } catch { return undefined; }
}
