import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { MangaError, createId } from "@manga/contracts";

/**
 * Platform protection for saved credentials (计划 4.1). Every operation is asynchronous: Electron's synchronous safeStorage interface is deprecated
 * in 45 and removed in 46. `decrypt` may hand back `renewed`, the same secret encrypted again because the platform rotated its key; the caller stores it.
 */
export interface CredentialVault {
  available(): Promise<boolean>;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<{ plain: string; renewed?: Buffer }>;
}

export class UnavailableVault implements CredentialVault {
  async available(): Promise<boolean> {
    return false;
  }
  async encrypt(): Promise<Buffer> {
    throw new MangaError("CREDENTIAL_UNAVAILABLE", "platform credential protection is unavailable");
  }
  async decrypt(): Promise<{ plain: string }> {
    throw new MangaError("CREDENTIAL_UNAVAILABLE", "platform credential protection is unavailable");
  }
}

/**
 * The vault the tests use: AES-GCM under a key derived from a secret (`tv1`). A ciphertext made with one of the `previous` secrets still opens and
 * comes back renewed under the current one, the way the platform answers after a key rotation.
 */
export class TestVault implements CredentialVault {
  private readonly secret: string;
  private readonly previous: readonly string[];
  constructor(secret: string, previous: readonly string[] = []) {
    this.secret = secret;
    this.previous = previous;
  }
  async available(): Promise<boolean> {
    return true;
  }
  async encrypt(plain: string): Promise<Buffer> {
    return tv1Encrypt(this.secret, plain);
  }
  async decrypt(cipher: Buffer): Promise<{ plain: string; renewed?: Buffer }> {
    try {
      return { plain: tv1Decrypt(this.secret, cipher) };
    } catch (error) {
      for (const secret of this.previous) {
        try {
          const plain = tv1Decrypt(secret, cipher);
          return { plain, renewed: tv1Encrypt(this.secret, plain) };
        } catch { /* try the next one */ }
      }
      throw error;
    }
  }
}

function tv1Encrypt(secret: string, plain: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("tv1"), salt, iv, tag, encrypted]);
}

function tv1Decrypt(secret: string, cipher: Buffer): string {
  const salt = cipher.subarray(3, 19);
  const iv = cipher.subarray(19, 31);
  const tag = cipher.subarray(31, 47);
  const encrypted = cipher.subarray(47);
  const key = scryptSync(secret, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** The part of Electron's safeStorage the vault uses: only the asynchronous interface. */
export interface AsyncSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plain: string): Promise<Buffer>;
  decryptStringAsync(buffer: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
}

export class ElectronSafeStorageVault implements CredentialVault {
  private readonly safeStorage: AsyncSafeStorage;
  /** How long the first call took: the asynchronous encryptor starts on first use after the app is ready. */
  firstCallMs: number | null = null;
  constructor(safeStorage: AsyncSafeStorage) {
    this.safeStorage = safeStorage;
  }
  async available(): Promise<boolean> {
    const started = performance.now();
    const ok = await this.safeStorage.isAsyncEncryptionAvailable();
    this.firstCallMs ??= performance.now() - started;
    return ok;
  }
  async encrypt(plain: string): Promise<Buffer> {
    if (!(await this.available())) throw new MangaError("CREDENTIAL_UNAVAILABLE", "safeStorage encryption is unavailable");
    return this.safeStorage.encryptStringAsync(plain);
  }
  async decrypt(cipher: Buffer): Promise<{ plain: string; renewed?: Buffer }> {
    if (!(await this.available())) throw new MangaError("CREDENTIAL_UNAVAILABLE", "safeStorage encryption is unavailable");
    const { shouldReEncrypt, result } = await this.safeStorage.decryptStringAsync(cipher);
    if (!shouldReEncrypt) return { plain: result };
    // The platform rotated its key: the secret is encrypted again so the next read does not depend on the old key.
    try {
      return { plain: result, renewed: await this.safeStorage.encryptStringAsync(result) };
    } catch {
      return { plain: result };
    }
  }
}

/** What reading and saving a credential need from the application. */
export interface CredentialHost {
  readonly vault: CredentialVault;
  readonly store: { readonly sqlite: { prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown } } };
}

const reads = new WeakMap<CredentialHost, Map<string, Promise<string | undefined>>>();

/**
 * Every decryption of a saved credential goes through here (计划 4.1): the row is read, decrypted, and when the platform hands back a renewed
 * ciphertext it is written back, only over the very ciphertext that was read, so two readers never write twice and a newer save is never
 * overwritten. A failed write-back does not fail the read. Two reads of the same credential at the same time share one decryption.
 * Returns undefined when nothing is saved under `ref`; a ciphertext that does not open throws.
 */
export function readCredential(host: CredentialHost, ref: string): Promise<string | undefined> {
  let pending = reads.get(host);
  if (!pending) reads.set(host, pending = new Map());
  const running = pending.get(ref);
  if (running) return running;
  const task = (async () => {
    const row = host.store.sqlite.prepare("SELECT ciphertext FROM credentials WHERE ref = ?").get(ref) as { ciphertext: Buffer } | undefined;
    if (!row) return undefined;
    const { plain, renewed } = await host.vault.decrypt(row.ciphertext);
    if (renewed) {
      try {
        host.store.sqlite.prepare("UPDATE credentials SET ciphertext = ? WHERE ref = ? AND ciphertext = ?").run(renewed, ref, row.ciphertext);
      } catch { /* the old ciphertext still opens; the next read tries again */ }
    }
    return plain;
  })();
  pending.set(ref, task);
  const done = () => { if (pending!.get(ref) === task) pending!.delete(ref); };
  task.then(done, done);
  return task;
}

/**
 * Encrypts a secret and saves it under a new reference. Without platform protection nothing is written, never plain text (CREDENTIAL_UNAVAILABLE).
 * The check comes before the secret is taken, so a refused save leaves the handle the page holds usable.
 */
export async function saveCredential(host: CredentialHost, take: () => string): Promise<string> {
  if (!(await host.vault.available())) throw new MangaError("CREDENTIAL_UNAVAILABLE", "cannot store credentials without platform protection");
  const secret = take();
  const ref = createId("cred");
  const cipher = await host.vault.encrypt(secret);
  host.store.sqlite.prepare("INSERT INTO credentials(ref, ciphertext, created_at) VALUES (?,?,?)").run(ref, cipher, new Date().toISOString());
  return ref;
}
