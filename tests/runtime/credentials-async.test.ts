import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { TestVault, UnavailableVault, type CredentialVault } from "@manga/app-core";
import { readCredential, saveCredential } from "../../packages/app-core/src/credentials.ts";
import { startApp } from "../helpers/app.ts";
import { FakeDandan } from "../helpers/fake-dandan.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";

// AT-141 / 计划 4.1: every credential read goes through one asynchronous function; a ciphertext the platform wants renewed is written back once,
// only over what was read; a failed write-back does not fail the read; without protection nothing is written.

type Row = { ref: string; ciphertext: Buffer };
function memoryHost(vault: CredentialVault, rows: Row[] = [], options: { failWrite?: boolean } = {}) {
  const writes: Array<{ ref: string; ciphertext: Buffer }> = [];
  const sqlite = {
    prepare(sql: string) {
      return {
        // Like SQLite, a read hands back a copy, not the stored bytes.
        get: (ref: unknown) => { const row = rows.find((item) => item.ref === ref); return row ? { ref: row.ref, ciphertext: Buffer.from(row.ciphertext) } : undefined; },
        run: (...params: unknown[]) => {
          if (sql.startsWith("UPDATE")) {
            if (options.failWrite) throw new Error("disk full");
            const [cipher, ref, old] = params as [Buffer, string, Buffer];
            const row = rows.find((item) => item.ref === ref && item.ciphertext.equals(old));
            if (row) { row.ciphertext = cipher; writes.push({ ref, ciphertext: cipher }); }
          } else if (sql.startsWith("INSERT")) {
            const [ref, cipher] = params as [string, Buffer];
            rows.push({ ref, ciphertext: cipher });
          }
          return {};
        },
      };
    },
  };
  return { host: { vault, store: { sqlite } }, rows, writes };
}

describe("reading a credential (AT-141)", () => {
  it("opens an old ciphertext, writes the renewed one back once, and the renewed one opens without the old key", async () => {
    const old = await new TestVault("old-key").encrypt("sk-model");
    const vault = new TestVault("new-key", ["old-key"]);
    const { host, rows, writes } = memoryHost(vault, [{ ref: "c1", ciphertext: old }]);
    // Two readers at the same time share one decryption and one write-back.
    const [a, b] = await Promise.all([readCredential(host, "c1"), readCredential(host, "c1")]);
    expect(a).toBe("sk-model");
    expect(b).toBe("sk-model");
    expect(writes).toHaveLength(1);
    expect(rows[0]!.ciphertext.equals(old)).toBe(false);
    expect((await new TestVault("new-key").decrypt(rows[0]!.ciphertext)).plain).toBe("sk-model");
    // Once renewed, the next read has nothing to write.
    expect(await readCredential(host, "c1")).toBe("sk-model");
    expect(writes).toHaveLength(1);
  });

  it("still answers when the write-back fails, and keeps the old ciphertext", async () => {
    const old = await new TestVault("old-key").encrypt("token");
    const { host, rows } = memoryHost(new TestVault("new-key", ["old-key"]), [{ ref: "c1", ciphertext: old }], { failWrite: true });
    expect(await readCredential(host, "c1")).toBe("token");
    expect(rows[0]!.ciphertext.equals(old)).toBe(true);
  });

  it("does not overwrite a ciphertext saved while it was decrypting", async () => {
    const old = await new TestVault("old-key").encrypt("first");
    const newer = await new TestVault("new-key").encrypt("second");
    const rows: Row[] = [{ ref: "c1", ciphertext: old }];
    const slow: CredentialVault = {
      available: async () => true,
      encrypt: async (plain) => new TestVault("new-key").encrypt(plain),
      decrypt: async (cipher) => {
        const result = await new TestVault("new-key", ["old-key"]).decrypt(cipher);
        rows[0]!.ciphertext = newer; // the person saved another key meanwhile
        return result;
      },
    };
    const { host, writes } = memoryHost(slow, rows);
    expect(await readCredential(host, "c1")).toBe("first");
    expect(writes).toHaveLength(0);
    expect(rows[0]!.ciphertext.equals(newer)).toBe(true);
  });

  it("answers undefined for a missing row and throws for a ciphertext that does not open", async () => {
    const { host } = memoryHost(new TestVault("k"), [{ ref: "bad", ciphertext: await new TestVault("other").encrypt("x") }]);
    expect(await readCredential(host, "none")).toBeUndefined();
    await expect(readCredential(host, "bad")).rejects.toThrow();
  });

  it("refuses to save without platform protection, writes nothing and leaves the handle usable", async () => {
    const { host, rows } = memoryHost(new UnavailableVault());
    let taken = false;
    await expect(saveCredential(host, () => { taken = true; return "secret"; })).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(taken).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe("credentials saved under an earlier key, read by the application (AT-141)", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

  it("the model key, the DanDanPlay credentials and the Bangumi token all open and are renewed", async () => {
    const modelKey = "synthetic-model-key-before-renewal";
    const dandanCredentials = { appId: "renewapp01", secret: "renew-secret-for-the-fake" };
    const bangumiToken = "synthetic-bangumi-token-renewal";
    const model = await startMockProvider({ expectKey: modelKey });
    cleanups.push(() => model.close());
    const dandan = await new FakeDandan().start();
    dandan.accepts = dandanCredentials;
    cleanups.push(() => dandan.stop());
    const bangumi: FakeBangumi = await startFakeBangumi();
    cleanups.push(() => bangumi.stop());
    const options = { danmaku: { credentials: null, origin: dandan.origin, client: { allowHttp: true } }, bangumi: bangumi.clientOptions };

    // Saved under the old key.
    const first = await startApp({ options: { ...options, vault: new TestVault("old-key") } });
    const profileRoot = first.profileRoot;
    const call = async (ctx: typeof first, commandId: string, input: unknown) => ctx.app.call(ctx.actor, { commandId, idempotencyKey: `${commandId}-${Math.random()}`, input }, ctx.grant.handle);
    expect((await call(first, "connections.upsert", { id: "conn_renew", label: "mock", protocol: "openai-chat-completions", baseUrl: model.url, modelId: "demo", purpose: "text", credentialHandle: first.app.stashSecret(modelKey) })).status).toBe("ok");
    expect((await call(first, "danmaku.setCredentials", { credentialHandle: first.app.stashSecret(JSON.stringify(dandanCredentials)) })).status).toBe("ok");
    expect((await call(first, "metadata.setProvider", { providerId: "bangumi", enabled: true, credentialHandle: first.app.stashSecret(bangumiToken) })).status).toBe("ok");
    const before = new Map((first.app.store.sqlite.prepare("SELECT ref, ciphertext FROM credentials").all() as Row[]).map((row) => [row.ref, Buffer.from(row.ciphertext)]));
    expect(before.size).toBe(3);
    for (const cipher of before.values()) for (const secret of [modelKey, dandanCredentials.secret, bangumiToken]) expect(cipher.includes(Buffer.from(secret))).toBe(false);
    first.app.close();

    // Read under the new key, with the old one only able to open what is there.
    const second = await startApp({ profileRoot, options: { ...options, vault: new TestVault("new-key", ["old-key"]) } });
    cleanups.push(() => second.app.close());
    const tested = await call(second, "connections.test", { connectionId: "conn_renew", capability: "text" });
    expect(tested.status, JSON.stringify(tested)).toBe("ok");
    expect((tested.value as { ok: boolean }).ok).toBe(true);
    const status = await call(second, "danmaku.getSettings", {});
    expect((status.value as { credentials: string }).credentials).toBe("custom");
    const searched = await call(second, "danmaku.search", { query: "样例" });
    expect(searched.status, JSON.stringify(searched)).toBe("ok");
    expect(dandan.requests.length).toBeGreaterThan(0);
    expect(dandan.requests.every((request) => request.signed)).toBe(true);
    await call(second, "metadata.search", { query: "Synthetic", providerIds: ["bangumi"] });
    const api = bangumi.requests.filter((item) => item.path.startsWith("/v0/"));
    expect(api.length).toBeGreaterThan(0);
    for (const item of api) expect(item.headers.authorization).toBe(`Bearer ${bangumiToken}`);
    // Every credential was renewed and opens under the new key alone.
    const after = second.app.store.sqlite.prepare("SELECT ref, ciphertext FROM credentials").all() as Row[];
    expect(after).toHaveLength(3);
    const fresh = new TestVault("new-key");
    for (const row of after) {
      expect(Buffer.from(row.ciphertext).equals(before.get(row.ref)!)).toBe(false);
      await expect(fresh.decrypt(Buffer.from(row.ciphertext))).resolves.toBeTruthy();
    }
  });

  it("settings report the vault as unavailable and saving a key fails without writing plain text", async () => {
    const ctx = await startApp({ options: { vault: new UnavailableVault() } });
    cleanups.push(() => ctx.app.close());
    const settings = await ctx.app.call(ctx.actor, { commandId: "settings.get", idempotencyKey: "s", input: {} }, ctx.grant.handle);
    expect((settings.value as { vaultAvailable: boolean }).vaultAvailable).toBe(false);
    const handle = ctx.app.stashSecret("sk-never-written");
    const saved = await ctx.app.call(ctx.actor, { commandId: "connections.upsert", idempotencyKey: "u", input: { label: "x", protocol: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", modelId: "m", purpose: "text", credentialHandle: handle } }, ctx.grant.handle);
    expect(saved.error?.code).toBe("CREDENTIAL_UNAVAILABLE");
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 0 });
    for (const commandId of ["danmaku.setCredentials", "metadata.setProvider"]) {
      const input = commandId === "danmaku.setCredentials" ? { credentialHandle: ctx.app.stashSecret(JSON.stringify({ appId: "abcd", secret: "efgh" })) } : { providerId: "bangumi", enabled: true, credentialHandle: ctx.app.stashSecret("tok") };
      expect((await ctx.app.call(ctx.actor, { commandId, idempotencyKey: commandId, input }, ctx.grant.handle)).error?.code).toBe("CREDENTIAL_UNAVAILABLE");
    }
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 0 });
  });
});
