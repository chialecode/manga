import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { MangaError, PLUGIN_PERMISSIONS, PluginManifestSchema, PluginSignatureSchema, type PluginFacet, type PluginManifest, type PluginPermission, type PluginSlot, type PluginTrust } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { writeExportFile } from "../creative/export-file.ts";
import { PLUGIN_LIMITS, compareVersions, fileHashes, fingerprintOf, rawPublicKey, readPluginPackage, refuse, safePayloadName, signatureHolds, type PluginParts } from "./package.ts";
import type { PluginRunInfo, PluginRuntime } from "./runtime.ts";
import { TrustStore } from "./trust.ts";

/**
 * Installing, upgrading, going back, enabling and removing plugin packages, and deciding for each whether it may run (PLUG-04, Q-06).
 * Every decision is made from what is on disk and in the trust store at that moment: a package is checked when it is read, an installed copy is
 * checked again each time its process starts, and trust is looked up live, so taking a key away stops what it signed.
 */

export type PluginState = "untrusted" | "incompatible" | "disabled" | "starting" | "running" | "stopped" | "failed" | "enabled";

export type PluginView = {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: { id: string; name: string };
  keyId: string;
  trust: PluginTrust;
  executable: boolean;
  permissions: PluginPermission[];
  granted: PluginPermission[];
  provides: Array<{ slot: PluginSlot; id: string }>;
  facets: PluginFacet[];
  enabled: boolean;
  state: PluginState;
  error: string | null;
  previousVersion: string | null;
  installedAt: string;
  signedAt: string;
  dataBytes: number;
};

export type PluginInspection = {
  manifest: Pick<PluginManifest, "id" | "name" | "version" | "description" | "publisher" | "permissions" | "provides" | "facets" | "host">;
  executable: boolean;
  keyId: string;
  fingerprint: string | null;
  trust: PluginTrust;
  signatureValid: boolean | null;
  hostCompatible: boolean;
  /** What installing it would do. */
  action: "install" | "upgrade" | "same-version" | "older";
  installedVersion: string | null;
  /** Permissions the package declares that the installed version did not have: they need a new confirmation. */
  newPermissions: PluginPermission[];
  /** Why it would be refused, with the sentence the host uses; null when it can be installed. */
  refusal: { reason: string; message: string } | null;
};

export type PluginLeftover = { pluginId: string; name: string; uninstalledAt: string; bytes: number };
export type BundledPlugin = { id: string; name: string; version: string; description: string; publisher: { id: string; name: string }; installed: boolean; installedVersion: string | null; trust: PluginTrust; fileName: string };

export type PluginOptions = {
  store: DrizzleStore;
  pluginsDir: string;
  dataDir: string;
  /** Packages that come with the application, offered for installation but never installed by themselves. */
  bundledDir?: string;
  appVersion: string;
  trust: TrustStore;
  runtime: PluginRuntime;
  notify: (topic: string, payload: Record<string, unknown>) => void;
};

type Row = { id: string; version: string; previous_version: string | null; enabled: number; granted_json: string; last_error: string | null; installed_at: string; updated_at: string };
type VersionRow = { plugin_id: string; version: string; key_id: string; manifest_json: string; files_json: string; signed_at: string; installed_at: string };

const BUNDLED_EXTENSION = ".manga-plugin";
const ZIP_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export class PluginService {
  private readonly o: PluginOptions;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: PluginOptions) {
    this.o = options;
    fs.mkdirSync(options.pluginsDir, { recursive: true });
    fs.mkdirSync(options.dataDir, { recursive: true });
    // A package that was half unpacked when the application ended is not an install: nothing in staging is ever used.
    fs.rmSync(path.join(options.pluginsDir, ".staging"), { recursive: true, force: true });
  }

  /** One change to the installed set at a time, so an upgrade cannot meet an uninstall halfway. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private get sqlite() { return this.o.store.sqlite; }
  private versionDir(id: string, version: string) { return path.join(this.o.pluginsDir, id, version); }
  private dataPath(id: string) { return path.join(this.o.dataDir, id); }

  // ----------------------------------------------------------------------------------------------------------- reading

  private row(id: string): Row {
    const row = this.sqlite.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw refuse("unknown", "that plugin is not installed", {}, "NOT_FOUND");
    return row;
  }

  private versionRow(id: string, version: string): VersionRow {
    const row = this.sqlite.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?").get(id, version) as VersionRow | undefined;
    if (!row) throw refuse("unknown", "that version is not installed", {}, "NOT_FOUND");
    return row;
  }

  private parseFile(file: string): PluginParts {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { throw refuse("source", "the package file is not there", {}, "NOT_FOUND"); }
    if (!stat.isFile()) throw refuse("source", "that is not a package file");
    if (stat.size > PLUGIN_LIMITS.fileBytes) throw refuse("size", "the package is too large");
    return readPluginPackage(fs.readFileSync(file));
  }

  private hostCompatible(manifest: PluginManifest): boolean {
    return compareVersions(this.o.appVersion, manifest.host.min) >= 0 && (!manifest.host.max || compareVersions(this.o.appVersion, manifest.host.max) <= 0);
  }

  /** A package against what the host knows: whether its key is trusted and the signature holds, whether it fits this application and the installed version. Throws nothing for policy; the refusal is in the result. */
  private evaluate(parts: PluginParts): PluginInspection & { key: ReturnType<TrustStore["resolve"]> } {
    const { manifest, signature } = parts;
    const key = this.o.trust.resolve(signature.keyId);
    const signatureValid = key ? signatureHolds(parts, key.key) : null;
    const installed = this.sqlite.prepare("SELECT version, granted_json FROM plugins WHERE id = ?").get(manifest.id) as { version: string; granted_json: string } | undefined;
    const previousPermissions = installed ? (JSON.parse((this.sqlite.prepare("SELECT manifest_json FROM plugin_versions WHERE plugin_id = ? AND version = ?").get(manifest.id, installed.version) as { manifest_json: string } | undefined)?.manifest_json ?? "{}") as { permissions?: PluginPermission[] }).permissions ?? [] : [];
    const compat = this.hostCompatible(manifest);
    const action: PluginInspection["action"] = !installed ? "install" : compareVersions(manifest.version, installed.version) > 0 ? "upgrade" : compareVersions(manifest.version, installed.version) === 0 ? "same-version" : "older";
    let refusal: PluginInspection["refusal"] = null;
    if (!key) refusal = { reason: "untrusted", message: "the publisher's key is not trusted" };
    else if (!signatureValid) refusal = { reason: "signature", message: "the signature does not match the package" };
    else if (!compat) refusal = { reason: "incompatible", message: "this application is not a version the plugin works with" };
    else if (action === "same-version") refusal = { reason: "same-version", message: "this version is already installed" };
    else if (action === "older") refusal = { reason: "older", message: "a newer version is installed; use go back to return to the version kept" };
    return {
      manifest: { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, publisher: manifest.publisher, permissions: manifest.permissions, provides: manifest.provides, facets: manifest.facets, host: manifest.host },
      executable: manifest.entry !== null, keyId: signature.keyId, fingerprint: key ? fingerprintOf(rawPublicKey(key.key)) : null, trust: key?.trust ?? "unknown", signatureValid, hostCompatible: compat, action,
      installedVersion: installed?.version ?? null, newPermissions: installed ? manifest.permissions.filter((permission) => !previousPermissions.includes(permission)) : manifest.permissions, refusal, key,
    };
  }

  private fromSource(source: { path: string }): PluginParts { return this.parseFile(source.path); }

  /** Says what installing a package would do, and whether it would be allowed, without changing anything. A file that is not a package at all is an error. */
  inspect(source: { path: string }): PluginInspection {
    const parts = this.fromSource(source);
    const { key: _key, ...inspection } = this.evaluate(parts);
    return inspection;
  }

  // ---------------------------------------------------------------------------------------------------------- listing

  list(): { plugins: PluginView[]; leftovers: PluginLeftover[] } {
    const rows = this.sqlite.prepare("SELECT * FROM plugins ORDER BY id").all() as Row[];
    const plugins = rows.map((row) => this.view(row));
    const leftovers = (this.sqlite.prepare("SELECT plugin_id AS pluginId, name, uninstalled_at AS uninstalledAt FROM plugin_leftovers ORDER BY uninstalled_at").all() as Array<{ pluginId: string; name: string; uninstalledAt: string }>)
      .map((item) => ({ ...item, bytes: this.dirBytes(this.dataPath(item.pluginId)) }));
    return { plugins, leftovers };
  }

  private view(row: Row): PluginView {
    const version = this.versionRow(row.id, row.version);
    const manifest = PluginManifestSchema.parse(JSON.parse(version.manifest_json));
    const key = this.o.trust.resolve(version.key_id);
    const compatible = this.hostCompatible(manifest);
    const run: PluginRunInfo = this.o.runtime.info(row.id);
    const executable = manifest.entry !== null;
    let state: PluginState;
    let error: string | null = row.last_error;
    if (!key) state = "untrusted";
    else if (!compatible) state = "incompatible";
    else if (!row.enabled) state = row.last_error ? "failed" : "disabled";
    else if (!executable) state = "enabled";
    else if (run.state === "running") state = "running";
    else if (run.state === "starting") state = "starting";
    else if (run.state === "failed") { state = "failed"; error = run.error ?? error; }
    else state = row.last_error ? "failed" : "stopped";
    return {
      id: row.id, name: manifest.name, version: row.version, description: manifest.description, publisher: manifest.publisher, keyId: version.key_id, trust: key?.trust ?? "unknown",
      executable, permissions: manifest.permissions, granted: JSON.parse(row.granted_json) as PluginPermission[], provides: manifest.provides, facets: manifest.facets,
      enabled: Boolean(row.enabled), state, error, previousVersion: row.previous_version, installedAt: row.installed_at, signedAt: version.signed_at, dataBytes: this.dirBytes(this.dataPath(row.id)),
    };
  }

  /** The packages that come with the application, whether each is installed, and who signed it. */
  bundled(): BundledPlugin[] {
    const dir = this.o.bundledDir;
    if (!dir || !fs.existsSync(dir)) return [];
    const found: BundledPlugin[] = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(BUNDLED_EXTENSION) || !ZIP_NAME.test(name)) continue;
      try {
        const parts = this.parseFile(path.join(dir, name));
        const key = this.o.trust.resolve(parts.signature.keyId);
        if (!key || !signatureHolds(parts, key.key)) continue;
        const installed = this.sqlite.prepare("SELECT version FROM plugins WHERE id = ?").get(parts.manifest.id) as { version: string } | undefined;
        found.push({ id: parts.manifest.id, name: parts.manifest.name, version: parts.manifest.version, description: parts.manifest.description, publisher: parts.manifest.publisher, installed: Boolean(installed), installedVersion: installed?.version ?? null, trust: key.trust, fileName: name });
      } catch { /* a package that does not read is not offered */ }
    }
    return found;
  }

  /** The file of a bundled package by plugin id. */
  bundledFile(pluginId: string): string {
    const dir = this.o.bundledDir;
    const hit = this.bundled().find((item) => item.id === pluginId);
    if (!dir || !hit) throw refuse("unknown", "the application carries no such plugin", {}, "NOT_FOUND");
    return path.join(dir, hit.fileName);
  }

  trustList() { return { keys: this.o.trust.list() }; }

  // ---------------------------------------------------------------------------------------------------------- install

  /**
   * Installs a package: only if its key is trusted and its signature holds, it fits this application, the version is newer than the one installed, and
   * the person confirmed every permission it declares. Written in a staging folder, checked again from disk, then moved into place and recorded in one step.
   * An upgrade keeps the version it replaces, so it can be undone.
   */
  install(source: { path: string }, grant: readonly PluginPermission[], enable = true): Promise<{ pluginId: string; version: string; action: "install" | "upgrade"; enabled: boolean; error: string | null; rolledBack: boolean }> {
    return this.serialize(async () => {
      const parts = this.fromSource(source);
      const checked = this.evaluate(parts);
      if (checked.refusal) throw refuse(checked.refusal.reason as never, checked.refusal.message, { keyId: parts.signature.keyId, ...(checked.refusal.reason === "same-version" || checked.refusal.reason === "older" ? { installed: checked.installedVersion } : {}) }, checked.refusal.reason === "untrusted" ? "FORBIDDEN" : checked.refusal.reason === "incompatible" ? "API_INCOMPATIBLE" : "VALIDATION_ERROR");
      const missing = parts.manifest.permissions.filter((permission) => !grant.includes(permission));
      if (missing.length) throw refuse("permissions", "the permissions the plugin declares were not all confirmed", { missing, newPermissions: checked.newPermissions }, "FORBIDDEN");
      const { manifest } = parts;
      const existing = this.sqlite.prepare("SELECT * FROM plugins WHERE id = ?").get(manifest.id) as Row | undefined;
      const wasRunning = Boolean(existing?.enabled);
      if (existing) await this.o.runtime.stop(manifest.id);

      const staging = path.join(this.o.pluginsDir, ".staging", `${manifest.id}-${manifest.version}-${randomBytes(4).toString("hex")}`);
      const finalDir = this.versionDir(manifest.id, manifest.version);
      try {
        this.writeTree(staging, parts);
        this.loadFrom(staging, parts.signature.keyId);
        fs.rmSync(finalDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(finalDir), { recursive: true });
        fs.renameSync(staging, finalDir);
        const now = new Date().toISOString();
        this.sqlite.transaction(() => {
          this.sqlite.prepare("INSERT OR REPLACE INTO plugin_versions(plugin_id, version, key_id, manifest_json, files_json, signed_at, installed_at) VALUES (?,?,?,?,?,?,?)")
            .run(manifest.id, manifest.version, parts.signature.keyId, JSON.stringify(manifest), JSON.stringify(fileHashes(parts.files)), parts.signature.signedAt, now);
          if (existing) {
            this.sqlite.prepare("UPDATE plugins SET version = ?, previous_version = ?, enabled = 0, granted_json = ?, last_error = NULL, updated_at = ? WHERE id = ?")
              .run(manifest.version, existing.version, JSON.stringify(manifest.permissions), now, manifest.id);
          } else {
            this.sqlite.prepare("INSERT INTO plugins(id, version, previous_version, enabled, granted_json, last_error, installed_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
              .run(manifest.id, manifest.version, null, 0, JSON.stringify(manifest.permissions), null, now, now);
            this.sqlite.prepare("DELETE FROM plugin_leftovers WHERE plugin_id = ?").run(manifest.id);
          }
        })();
        if (existing) this.prune(manifest.id, [manifest.version, existing.version]);
      } catch (error) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw error;
      }

      const action = existing ? "upgrade" : "install";
      let enabled = false;
      let error: string | null = null;
      let rolledBack = false;
      if (enable || wasRunning) {
        try { await this.enableNow(manifest.id); enabled = true; } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
          // An upgrade that cannot start puts the version that worked back, so a bad release does not leave a person without the plugin.
          if (existing) { try { await this.rollbackNow(manifest.id, wasRunning); rolledBack = true; enabled = wasRunning; } catch { /* the plugin stays installed, stopped, with the reason */ } }
        }
      }
      this.o.notify("plugin.changed", { pluginId: manifest.id, change: action });
      return { pluginId: manifest.id, version: rolledBack ? existing!.version : manifest.version, action, enabled, error, rolledBack };
    });
  }

  /** Writes the package's files under a folder, refusing anything that would land outside it. */
  private writeTree(root: string, parts: PluginParts): void {
    fs.mkdirSync(path.join(root, "payload"), { recursive: true });
    fs.writeFileSync(path.join(root, "manifest.json"), parts.manifestBytes);
    fs.writeFileSync(path.join(root, "signature.json"), strToU8(`${JSON.stringify(parts.signature, null, 2)}\n`));
    for (const [name, bytes] of parts.files) {
      const target = path.join(root, "payload", ...name.split("/"));
      if (!safePayloadName(`payload/${name}`) || !path.resolve(target).startsWith(path.resolve(root, "payload") + path.sep)) throw refuse("unsafe", "a file in the package would land outside it");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx" });
    }
  }

  /** Reads an installed copy back from disk and checks it as strictly as a package: the manifest and files against the signature, the key against the trust store. */
  private loadFrom(dir: string, expectedKeyId?: string): { parts: PluginParts; trust: PluginTrust } {
    const read = (name: string) => { try { return fs.readFileSync(path.join(dir, name)); } catch { throw refuse("integrity", "an installed file is missing"); } };
    let manifest: PluginManifest;
    let signature;
    const manifestBytes = read("manifest.json");
    try { manifest = PluginManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8"))); signature = PluginSignatureSchema.parse(JSON.parse(read("signature.json").toString("utf8"))); } catch (error) {
      if (error instanceof MangaError) throw error;
      throw refuse("integrity", "an installed file does not read as it did");
    }
    const files = new Map<string, Uint8Array>();
    const walk = (relative: string) => {
      for (const entry of fs.readdirSync(path.join(dir, "payload", relative), { withFileTypes: true })) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw refuse("integrity", "an installed file is a link");
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile()) files.set(next, fs.readFileSync(path.join(dir, "payload", next)));
      }
    };
    try { walk(""); } catch (error) { if (error instanceof MangaError) throw error; throw refuse("integrity", "the installed files cannot be read"); }
    const parts: PluginParts = { manifest, manifestBytes, files, signature };
    if (expectedKeyId && signature.keyId !== expectedKeyId) throw refuse("integrity", "the installed signature is not the one recorded");
    const key = this.o.trust.resolve(signature.keyId);
    if (!key) throw refuse("untrusted", "the publisher's key is no longer trusted", { keyId: signature.keyId }, "FORBIDDEN");
    if (!signatureHolds(parts, key.key)) throw refuse("integrity", "the installed files no longer match their signature");
    return { parts, trust: key.trust };
  }

  /** The versions beyond the current one and the one before it are removed. */
  private prune(id: string, keep: string[]): void {
    for (const row of this.sqlite.prepare("SELECT version FROM plugin_versions WHERE plugin_id = ?").all(id) as Array<{ version: string }>) {
      if (keep.includes(row.version)) continue;
      this.sqlite.prepare("DELETE FROM plugin_versions WHERE plugin_id = ? AND version = ?").run(id, row.version);
      fs.rmSync(this.versionDir(id, row.version), { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------------------------------------------------- enable / stop

  /** Everything that must hold before a plugin's process may start, then the start. Used by enabling and by the application's own start. */
  private async startProcess(id: string): Promise<void> {
    const row = this.row(id);
    const version = this.versionRow(id, row.version);
    const { parts } = this.loadFrom(this.versionDir(id, row.version), version.key_id);
    if (!this.hostCompatible(parts.manifest)) throw refuse("incompatible", "this application is not a version the plugin works with", {}, "API_INCOMPATIBLE");
    const granted = JSON.parse(row.granted_json) as PluginPermission[];
    const missing = parts.manifest.permissions.filter((permission) => !granted.includes(permission));
    if (missing.length) throw refuse("permissions", "the plugin has permissions that were not confirmed", { missing }, "FORBIDDEN");
    if (parts.manifest.entry === null) return;
    fs.mkdirSync(this.dataPath(id), { recursive: true });
    const root = path.join(this.versionDir(id, row.version), "payload");
    await this.o.runtime.start({ pluginId: id, entry: path.join(root, ...parts.manifest.entry.split("/")), cwd: root, dataDir: this.dataPath(id), granted });
  }

  private async enableNow(id: string): Promise<void> {
    try {
      await this.startProcess(id);
    } catch (error) {
      this.sqlite.prepare("UPDATE plugins SET enabled = 0, last_error = ?, updated_at = ? WHERE id = ?").run(error instanceof Error ? error.message.slice(0, 500) : String(error), new Date().toISOString(), id);
      throw error;
    }
    this.sqlite.prepare("UPDATE plugins SET enabled = 1, last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  enable(id: string): Promise<PluginView> {
    return this.serialize(async () => {
      this.row(id);
      await this.enableNow(id);
      this.o.notify("plugin.changed", { pluginId: id, change: "enabled" });
      return this.view(this.row(id));
    });
  }

  disable(id: string): Promise<PluginView> {
    return this.serialize(async () => {
      this.row(id);
      await this.o.runtime.stop(id);
      this.sqlite.prepare("UPDATE plugins SET enabled = 0, last_error = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.o.notify("plugin.changed", { pluginId: id, change: "disabled" });
      return this.view(this.row(id));
    });
  }

  /** Goes back to the version kept from before the last upgrade. The version it leaves becomes the one kept, so going back twice returns to where it was. */
  rollback(id: string): Promise<PluginView> {
    return this.serialize(async () => {
      const row = this.row(id);
      const wasEnabled = Boolean(row.enabled);
      await this.rollbackNow(id, wasEnabled);
      this.o.notify("plugin.changed", { pluginId: id, change: "rollback" });
      return this.view(this.row(id));
    });
  }

  private async rollbackNow(id: string, restart: boolean): Promise<void> {
    const row = this.row(id);
    if (!row.previous_version) throw refuse("no-previous", "there is no earlier version kept");
    const target = this.versionRow(id, row.previous_version);
    const manifest = PluginManifestSchema.parse(JSON.parse(target.manifest_json));
    const granted = JSON.parse(row.granted_json) as PluginPermission[];
    const missing = manifest.permissions.filter((permission) => !granted.includes(permission));
    if (missing.length) throw refuse("permissions", "the earlier version needs permissions that were not confirmed", { missing }, "FORBIDDEN");
    await this.o.runtime.stop(id);
    this.sqlite.prepare("UPDATE plugins SET version = ?, previous_version = ?, enabled = 0, last_error = NULL, updated_at = ? WHERE id = ?").run(row.previous_version, row.version, new Date().toISOString(), id);
    if (restart) await this.enableNow(id);
  }

  // -------------------------------------------------------------------------------------------------------- uninstall

  /** Removes the plugin. What it kept (its data folder) stays for the person to export or delete, unless they say to delete it with the plugin. */
  uninstall(id: string, deleteData = false): Promise<{ pluginId: string; pluginName: string; keptData: boolean }> {
    return this.serialize(async () => {
      const row = this.row(id);
      const name = (JSON.parse(this.versionRow(id, row.version).manifest_json) as { name: string }).name;
      await this.o.runtime.stop(id);
      this.sqlite.transaction(() => {
        this.sqlite.prepare("DELETE FROM plugins WHERE id = ?").run(id);
        this.sqlite.prepare("DELETE FROM plugin_versions WHERE plugin_id = ?").run(id);
      })();
      fs.rmSync(path.join(this.o.pluginsDir, id), { recursive: true, force: true });
      const hasData = fs.existsSync(this.dataPath(id)) && this.dirBytes(this.dataPath(id)) > 0;
      if (deleteData || !hasData) fs.rmSync(this.dataPath(id), { recursive: true, force: true });
      else this.sqlite.prepare("INSERT OR REPLACE INTO plugin_leftovers(plugin_id, name, uninstalled_at) VALUES (?,?,?)").run(id, name, new Date().toISOString());
      this.o.notify("plugin.changed", { pluginId: id, change: "uninstalled" });
      return { pluginId: id, pluginName: name, keptData: !deleteData && hasData };
    });
  }

  private dirBytes(dir: string): number {
    let total = 0;
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const next = path.join(current, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile()) { try { total += fs.statSync(next).size; } catch { /* gone meanwhile */ } }
      }
    };
    walk(dir);
    return total;
  }

  /** Writes what the plugin kept into one zip in a folder the person chose, whether the plugin is installed or was uninstalled. */
  exportData(id: string, dir: string): { fileName: string; bytes: number; files: number } {
    const known = this.sqlite.prepare("SELECT 1 FROM plugins WHERE id = ?").get(id) || this.sqlite.prepare("SELECT 1 FROM plugin_leftovers WHERE plugin_id = ?").get(id);
    if (!known) throw refuse("unknown", "there is no such plugin or data", {}, "NOT_FOUND");
    const root = this.dataPath(id);
    const entries: Record<string, Uint8Array> = {};
    let total = 0;
    const walk = (relative: string) => {
      let listing: fs.Dirent[];
      try { listing = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch { return; }
      for (const entry of listing) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next);
        else if (entry.isFile()) {
          const bytes = fs.readFileSync(path.join(root, ...next.split("/")));
          total += bytes.length;
          if (total > PLUGIN_LIMITS.totalBytes) throw new MangaError("QUOTA_EXCEEDED", "what the plugin kept is too large for one file", { details: { reason: "size" } });
          entries[next] = bytes;
        }
      }
    };
    walk("");
    const names = Object.keys(entries);
    if (!names.length) throw new MangaError("NOT_FOUND", "the plugin kept nothing", { details: { reason: "empty" } });
    const manifestNote = strToU8(`${JSON.stringify({ format: "manga-plugin-data-v1", pluginId: id, exportedAt: new Date().toISOString(), files: names.length }, null, 2)}\n`);
    const zip = Buffer.from(zipSync({ "export.json": manifestNote, ...Object.fromEntries(names.map((name) => [`data/${name}`, entries[name]!])) }, { level: 6 }));
    const written = writeExportFile(dir, `${id}.plugin-data`, "zip", zip, "plugin-data");
    return { ...written, files: names.length };
  }

  /** Deletes what a plugin kept. Not while the plugin is installed and enabled: it may be using it. */
  deleteData(id: string): Promise<{ pluginId: string; pluginName: string }> {
    return this.serialize(async () => {
      const row = this.sqlite.prepare("SELECT enabled FROM plugins WHERE id = ?").get(id) as { enabled: number } | undefined;
      if (row?.enabled) throw refuse("running", "turn the plugin off before deleting what it kept");
      const left = this.sqlite.prepare("SELECT name FROM plugin_leftovers WHERE plugin_id = ?").get(id) as { name: string } | undefined;
      if (!row && !left) throw refuse("unknown", "there is no such plugin or data", {}, "NOT_FOUND");
      const name = left?.name ?? (JSON.parse(this.versionRow(id, this.row(id).version).manifest_json) as { name: string }).name;
      fs.rmSync(this.dataPath(id), { recursive: true, force: true });
      this.sqlite.prepare("DELETE FROM plugin_leftovers WHERE plugin_id = ?").run(id);
      this.o.notify("plugin.changed", { pluginId: id, change: "data-deleted" });
      return { pluginId: id, pluginName: name };
    });
  }

  // ------------------------------------------------------------------------------------------------------------- trust

  addTrust(publicKey: string, label: string) {
    const added = this.o.trust.add(publicKey, label);
    return this.reconcileTrust().then(() => ({ key: added }));
  }

  removeTrust(keyId: string) {
    this.o.trust.remove(keyId);
    return this.reconcileTrust().then(() => ({ keyId }));
  }

  /** After trust changes: what a removed key signed stops, and what an added key signs and the person had enabled starts. */
  reconcileTrust(): Promise<void> {
    return this.serialize(async () => {
      for (const row of this.sqlite.prepare("SELECT * FROM plugins").all() as Row[]) {
        const version = this.versionRow(row.id, row.version);
        const trusted = Boolean(this.o.trust.resolve(version.key_id));
        const running = this.o.runtime.info(row.id).state !== "stopped";
        if (!trusted && running) await this.o.runtime.stop(row.id);
        if (!trusted && row.enabled) this.sqlite.prepare("UPDATE plugins SET last_error = ?, updated_at = ? WHERE id = ?").run("the publisher's key is no longer trusted", new Date().toISOString(), row.id);
        if (trusted && row.enabled && !running) {
          try { await this.startProcess(row.id); this.sqlite.prepare("UPDATE plugins SET last_error = NULL WHERE id = ?").run(row.id); } catch (error) { this.sqlite.prepare("UPDATE plugins SET last_error = ? WHERE id = ?").run(error instanceof Error ? error.message.slice(0, 500) : String(error), row.id); }
        }
      }
      this.o.notify("plugin.changed", { change: "trust" });
    });
  }

  // ----------------------------------------------------------------------------------------------------- application use

  /** Starts what the person had enabled, when the application starts. A plugin that cannot start stays recorded with the reason and does not stop the rest. */
  restore(): Promise<void> {
    return this.serialize(async () => {
      for (const row of this.sqlite.prepare("SELECT * FROM plugins WHERE enabled = 1").all() as Row[]) {
        try { await this.startProcess(row.id); this.sqlite.prepare("UPDATE plugins SET last_error = NULL WHERE id = ?").run(row.id); } catch (error) {
          this.sqlite.prepare("UPDATE plugins SET last_error = ?, updated_at = ? WHERE id = ?").run(error instanceof Error ? error.message.slice(0, 500) : String(error), new Date().toISOString(), row.id);
        }
      }
      this.o.notify("plugin.changed", { change: "restored" });
    });
  }

  /** The enabled, trusted plugins that fill a slot, in plugin id order; the application picks among them. */
  providers(slot: PluginSlot, options: { includeDisabled?: boolean } = {}): Array<{ pluginId: string; id: string; running: boolean; enabled: boolean }> {
    const found: Array<{ pluginId: string; id: string; running: boolean; enabled: boolean }> = [];
    for (const row of this.sqlite.prepare(`SELECT * FROM plugins ${options.includeDisabled ? "" : "WHERE enabled = 1"} ORDER BY id`).all() as Row[]) {
      const version = this.versionRow(row.id, row.version);
      if (!this.o.trust.resolve(version.key_id)) continue;
      const manifest = PluginManifestSchema.parse(JSON.parse(version.manifest_json));
      if (!this.hostCompatible(manifest)) continue;
      for (const item of manifest.provides) if (item.slot === slot) found.push({ pluginId: row.id, id: item.id, running: this.o.runtime.isRunning(row.id), enabled: row.enabled === 1 });
    }
    return found;
  }

  /** The parts of the interface that enabled, trusted plugins turn on. */
  facets(): Set<PluginFacet> {
    const set = new Set<PluginFacet>();
    for (const row of this.sqlite.prepare("SELECT * FROM plugins WHERE enabled = 1").all() as Row[]) {
      const version = this.versionRow(row.id, row.version);
      if (!this.o.trust.resolve(version.key_id)) continue;
      const manifest = PluginManifestSchema.parse(JSON.parse(version.manifest_json));
      if (this.hostCompatible(manifest)) for (const facet of manifest.facets) set.add(facet);
    }
    return set;
  }

  /** What the person confirmed for a plugin. */
  grantedTo(id: string): PluginPermission[] {
    const row = this.sqlite.prepare("SELECT granted_json FROM plugins WHERE id = ?").get(id) as { granted_json: string } | undefined;
    return row ? (JSON.parse(row.granted_json) as PluginPermission[]).filter((item) => (PLUGIN_PERMISSIONS as readonly string[]).includes(item)) : [];
  }

  async shutdown(): Promise<void> { await this.o.runtime.shutdown(); }
}
