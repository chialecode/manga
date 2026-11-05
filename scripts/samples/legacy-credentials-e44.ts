// Makes the Profile the `credentials-async` window observation starts from: a model key, DanDanPlay credentials and a Bangumi token saved through the
// synchronous safeStorage interface of Electron 44 (计划 4.1), so the packaged Electron 45 build proves it reads what the earlier release wrote.
// Run on Electron 44 (it must be the main script of an Electron 44 process): node scripts/samples/build-legacy-credentials.mjs.
// The ciphertext is bound to this Windows account (DPAPI); the Profile stays under dist/samples and is never committed.
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage } from "electron";
import { MangaProductApp, type CredentialVault } from "@manga/app-core";
import { LEGACY_CREDENTIALS } from "../../tests/helpers/legacy-credentials.ts";

/** What the Electron 44 release did: the synchronous safeStorage interface. The only place in the repository allowed to call it (scripts/check-deps.mjs). */
const legacyVault: CredentialVault = {
  available: async () => safeStorage.isEncryptionAvailable(),
  encrypt: async (plain) => safeStorage.encryptString(plain),
  decrypt: async (cipher) => ({ plain: safeStorage.decryptString(cipher) }),
};

const home = process.env.MANGA_LEGACY_HOME;
if (!home) throw new Error("MANGA_LEGACY_HOME is not set");
const root = path.join(home, "root");
// The same place the desktop main process gives Chromium (the runtime partition), so the key that protects the ciphertext is found again.
app.setPath("userData", path.join(root, "runtime"));
app.setPath("sessionData", path.join(root, "runtime"));

app.whenReady().then(async () => {
  let status = 1;
  try {
    const service = new MangaProductApp({
      profileRoot: root, channel: "test", pointerPath: path.join(home, "launcher", "pointer.json"), documentsDir: path.join(home, "documents"),
      packaged: false, hostId: "desktop", vault: legacyVault,
    });
    await service.start();
    const actor = { kind: "user" as const, id: "desktop-user" };
    const grant = service.issueOwnerGrant(actor).handle;
    const call = async (commandId: string, input: unknown) => {
      const result = await service.call(actor, { commandId, idempotencyKey: `legacy-${commandId}`, input }, grant);
      if (result.status !== "ok") throw new Error(`${commandId}: ${JSON.stringify(result.error)}`);
      return result.value;
    };
    await call("connections.upsert", { id: LEGACY_CREDENTIALS.connectionId, label: "legacy", protocol: "openai-chat-completions", baseUrl: "http://127.0.0.1:9/v1", modelId: "demo", purpose: "text", credentialHandle: service.stashSecret(LEGACY_CREDENTIALS.modelKey) });
    await call("danmaku.setCredentials", { credentialHandle: service.stashSecret(JSON.stringify(LEGACY_CREDENTIALS.dandan)) });
    await call("metadata.setProvider", { providerId: "bangumi", enabled: true, credentialHandle: service.stashSecret(LEGACY_CREDENTIALS.bangumiToken) });
    service.close();
    fs.writeFileSync(path.join(home, "legacy.json"), `${JSON.stringify({ electron: process.versions.electron, madeAt: new Date().toISOString() }, null, 2)}\n`);
    status = 0;
  } catch (error) {
    console.error(error);
  }
  // A normal quit, so Chromium writes Local State (it holds the key the ciphertext depends on); app.exit would skip that.
  process.exitCode = status;
  app.quit();
});
