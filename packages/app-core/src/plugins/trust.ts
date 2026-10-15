import type { KeyObject } from "node:crypto";
import type { PluginTrust } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { fingerprintOf, publicKeyFromBase64, refuse } from "./package.ts";

/**
 * The public keys of the application's own plugins, the first party. The private half is held by the people who build the application and is
 * never in the repository; a plugin signed by it is the application's own, and its key cannot be removed here. A second key can be listed
 * beside the first when the first is retired.
 */
export const FIRST_PARTY_KEYS: ReadonlyArray<{ publicKey: string; label: string }> = [
  { publicKey: "UjoO3KoK7oWmsA1xWmjAnJDlxuLz/bqcLG2AYlYuUXk=", label: "MANGA（第一方）" },
];

export type TrustedKey = { keyId: string; label: string; trust: Exclude<PluginTrust, "unknown">; fingerprint: string; addedAt: string | null };

/**
 * Which keys the host trusts to sign a plugin: the first-party keys that come with the application, and the keys the person chose to trust.
 * Trust is read when it is needed, never kept on an installed plugin, so taking a key away takes effect for everything it signed.
 */
export class TrustStore {
  private readonly store: DrizzleStore;
  private readonly builtIn: Map<string, { key: KeyObject; raw: Buffer; label: string }>;

  constructor(store: DrizzleStore, builtIn: ReadonlyArray<{ publicKey: string; label: string }> = FIRST_PARTY_KEYS) {
    this.store = store;
    this.builtIn = new Map(builtIn.map((item) => { const parsed = publicKeyFromBase64(item.publicKey); return [parsed.keyId, { key: parsed.key, raw: parsed.raw, label: item.label }]; }));
  }

  /** The key that signed something, and why it is trusted; null when the host does not trust it. */
  resolve(keyId: string): { key: KeyObject; trust: Exclude<PluginTrust, "unknown">; label: string } | null {
    const own = this.builtIn.get(keyId);
    if (own) return { key: own.key, trust: "first-party", label: own.label };
    const row = this.store.sqlite.prepare("SELECT public_key AS publicKey, label FROM plugin_keys WHERE key_id = ?").get(keyId) as { publicKey: string; label: string } | undefined;
    return row ? { key: publicKeyFromBase64(row.publicKey).key, trust: "user", label: row.label } : null;
  }

  list(): TrustedKey[] {
    const own: TrustedKey[] = [...this.builtIn.entries()].map(([keyId, item]) => ({ keyId, label: item.label, trust: "first-party", fingerprint: fingerprintOf(item.raw), addedAt: null }));
    const rows = this.store.sqlite.prepare("SELECT key_id AS keyId, public_key AS publicKey, label, added_at AS addedAt FROM plugin_keys ORDER BY added_at, key_id").all() as Array<{ keyId: string; publicKey: string; label: string; addedAt: string }>;
    return [...own, ...rows.map((row): TrustedKey => ({ keyId: row.keyId, label: row.label, trust: "user", fingerprint: fingerprintOf(Buffer.from(row.publicKey, "base64")), addedAt: row.addedAt }))];
  }

  /** Trusts a key the person was given. Trusting one the application already trusts changes nothing. */
  add(publicKey: string, label: string, now = new Date().toISOString()): TrustedKey {
    const parsed = publicKeyFromBase64(publicKey);
    if (!this.builtIn.has(parsed.keyId)) {
      this.store.sqlite.prepare("INSERT INTO plugin_keys(key_id, public_key, label, added_at) VALUES (?,?,?,?) ON CONFLICT(key_id) DO UPDATE SET label = excluded.label").run(parsed.keyId, parsed.raw.toString("base64"), label, now);
    }
    return this.list().find((item) => item.keyId === parsed.keyId)!;
  }

  /** Stops trusting a key the person added. The application's own keys stay. */
  remove(keyId: string): void {
    if (this.builtIn.has(keyId)) throw refuse("key", "the application's own key cannot be removed");
    const done = this.store.sqlite.prepare("DELETE FROM plugin_keys WHERE key_id = ?").run(keyId).changes;
    if (!done) throw refuse("key", "that key is not trusted", {}, "NOT_FOUND");
  }
}
