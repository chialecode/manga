import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { MangaError } from "@manga/contracts";

export interface CredentialVault {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export class UnavailableVault implements CredentialVault {
  available(): boolean {
    return false;
  }
  encrypt(): Buffer {
    throw new MangaError("CREDENTIAL_UNAVAILABLE", "platform credential protection is unavailable");
  }
  decrypt(): string {
    throw new MangaError("CREDENTIAL_UNAVAILABLE", "platform credential protection is unavailable");
  }
}

export class TestVault implements CredentialVault {
  private readonly secret: string;
  constructor(secret: string) {
    this.secret = secret;
  }
  available(): boolean {
    return true;
  }
  encrypt(plain: string): Buffer {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(this.secret, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from("tv1"), salt, iv, tag, encrypted]);
  }
  decrypt(cipher: Buffer): string {
    const salt = cipher.subarray(3, 19);
    const iv = cipher.subarray(19, 31);
    const tag = cipher.subarray(31, 47);
    const encrypted = cipher.subarray(47);
    const key = scryptSync(this.secret, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}

export class ElectronSafeStorageVault implements CredentialVault {
  private readonly safeStorage: { isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(buffer: Buffer): string };
  constructor(safeStorage: { isEncryptionAvailable(): boolean; encryptString(plain: string): Buffer; decryptString(buffer: Buffer): string }) {
    this.safeStorage = safeStorage;
  }
  available(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }
  encrypt(plain: string): Buffer {
    if (!this.available()) throw new MangaError("CREDENTIAL_UNAVAILABLE", "safeStorage encryption is unavailable");
    return this.safeStorage.encryptString(plain);
  }
  decrypt(cipher: Buffer): string {
    if (!this.available()) throw new MangaError("CREDENTIAL_UNAVAILABLE", "safeStorage encryption is unavailable");
    return this.safeStorage.decryptString(cipher);
  }
}
