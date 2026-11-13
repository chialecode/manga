import { MangaError } from "@manga/contracts";
import { readCredential, type CredentialHost } from "../credentials.ts";
import type { ConnectionRow } from "../product-helpers.ts";
import type { ProviderEntry, ProviderRegistry } from "./registry.ts";

/** What the access check uses of the application. */
export type ProviderAccessHost = CredentialHost & { readonly providers: ProviderRegistry };

/** The provider a connection was added from, or undefined for one added by hand. Throws `PROVIDER_UNAVAILABLE` when its plugin is not usable now. */
export async function providerOf(app: ProviderAccessHost, row: Pick<ConnectionRow, "base_url"> & { account_id?: string | null }): Promise<ProviderEntry | undefined> {
  if (!row.account_id) return undefined;
  const account = app.store.sqlite.prepare("SELECT provider_ref FROM provider_accounts WHERE id = ?").get(row.account_id) as { provider_ref: string } | undefined;
  if (!account) throw new MangaError("NOT_FOUND", "the connection's account is missing");
  const entry = app.providers.require(account.provider_ref);
  await app.providers.checkAddress(entry, row.base_url);
  return entry;
}

/**
 * The key of a connection, after the check that its provider (if it has one) is usable: every request a connection makes starts here, so a connection whose
 * plugin is off makes none (计划 4.1). With `signal`, the call is also tracked so turning the plugin off cancels it; `release` ends the tracking.
 */
export async function connectionAccess(
  app: ProviderAccessHost,
  row: ConnectionRow,
  signal?: AbortSignal,
  verifiedProvider?: ProviderEntry,
): Promise<{ apiKey: string | undefined; provider: ProviderEntry | undefined; signal: AbortSignal | undefined; release: () => void }> {
  const provider = verifiedProvider ?? await providerOf(app, row);
  const apiKey = row.credential_ref ? await readCredential(app, row.credential_ref) : undefined;
  if (!provider) return { apiKey, provider, signal, release: () => undefined };
  const tracked = app.providers.track(provider.ref, signal);
  return { apiKey, provider, signal: tracked.signal, release: tracked.release };
}

/** What a cancelled provider call says: the plugin was turned off while it ran, or the caller stopped it. */
export function providerAbortReason(signal: AbortSignal | undefined): MangaError | undefined {
  return signal?.aborted && signal.reason instanceof MangaError ? signal.reason : undefined;
}
