import { z } from "zod";

/**
 * Plugin packages (PLUG-04): what a package says about itself, and the words the host uses for what it may do. A package is a zip of a manifest,
 * a payload and a signature. The manifest is a claim; only the signature checked against a key the host trusts turns it into an identity.
 */
export const PLUGIN_FORMAT = "manga-plugin-v1";
export const PLUGIN_SIGNATURE_FORMAT = "manga-plugin-signature-v1";

/**
 * What a plugin may ask the host for. The host only checks these at its own doors (the requests a plugin makes of the host); it does not
 * confine what the plugin's process does by itself, which is why an executable plugin is accepted only from a publisher the user trusts.
 */
export const PLUGIN_PERMISSIONS = ["network", "files", "library-import"] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** The places in the application a plugin can fill. A slot names one job, and the application decides who does it among the enabled plugins. */
export const PLUGIN_SLOTS = ["acquisition.engine"] as const;
export type PluginSlot = (typeof PLUGIN_SLOTS)[number];

/** The parts of the interface a plugin turns on while it is enabled. */
export const PLUGIN_FACETS = ["acquisition"] as const;
export type PluginFacet = (typeof PLUGIN_FACETS)[number];

/** Why the host trusts a package's signature: the key is one of the application's own, or the person said to trust it. */
export type PluginTrust = "first-party" | "user" | "unknown";

const name = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/, "a version is three numbers: 1.2.3");

export const PluginManifestSchema = z.object({
  format: z.literal(PLUGIN_FORMAT),
  id: z.string().min(2).max(64).regex(name),
  name: z.string().trim().min(1).max(80),
  version,
  publisher: z.object({ id: z.string().min(2).max(64).regex(name), name: z.string().trim().min(1).max(80) }).strict(),
  description: z.string().max(500),
  /** The versions of the application the plugin works with. */
  host: z.object({ min: version, max: version.optional() }).strict(),
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length),
  /** The file under the payload that runs in its own process; null for a package that only declares what it provides. */
  entry: z.string().min(1).max(200).nullable(),
  provides: z.array(z.object({ slot: z.enum(PLUGIN_SLOTS), id: z.string().min(1).max(64).regex(name) }).strict()).max(8),
  facets: z.array(z.enum(PLUGIN_FACETS)).max(PLUGIN_FACETS.length),
}).strict().superRefine((manifest, ctx) => {
  const dupes = (items: string[]) => new Set(items).size !== items.length;
  if (dupes(manifest.permissions)) ctx.addIssue({ code: "custom", message: "a permission is listed twice", path: ["permissions"] });
  if (dupes(manifest.facets)) ctx.addIssue({ code: "custom", message: "a facet is listed twice", path: ["facets"] });
  if (dupes(manifest.provides.map((item) => `${item.slot}/${item.id}`))) ctx.addIssue({ code: "custom", message: "a slot is filled twice", path: ["provides"] });
  if (manifest.entry !== null && !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:mjs|cjs|js)$/.test(manifest.entry)) ctx.addIssue({ code: "custom", message: "the entry is not a script inside the payload", path: ["entry"] });
  if (manifest.entry === null && manifest.provides.length) ctx.addIssue({ code: "custom", message: "a package with no entry cannot fill a slot", path: ["provides"] });
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginSignatureSchema = z.object({
  format: z.literal(PLUGIN_SIGNATURE_FORMAT),
  algorithm: z.literal("ed25519"),
  /** The first 16 hex digits of the SHA-256 of the raw public key. */
  keyId: z.string().regex(/^[a-f0-9]{16}$/),
  signedAt: z.string().max(40),
  signature: z.string().min(40).max(200),
}).strict();
export type PluginSignature = z.infer<typeof PluginSignatureSchema>;

/** Why a package or a request about one was refused; each has a sentence of its own in the plugin page. */
export const PLUGIN_REFUSALS = [
  "format", "size", "unsafe", "manifest", "entry", "unsigned", "signature", "untrusted", "incompatible", "permissions",
  "same-version", "older", "unknown", "disabled", "integrity", "no-previous", "running", "key", "source",
] as const;
export type PluginRefusal = (typeof PLUGIN_REFUSALS)[number];
