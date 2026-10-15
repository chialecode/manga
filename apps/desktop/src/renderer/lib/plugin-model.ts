import { PLUGIN_PERMISSIONS, PLUGIN_REFUSALS, type PluginFacet, type PluginPermission, type PluginSlot } from "@manga/contracts/plugin";
import type { MessageKey } from "@manga/i18n";
import type { CommandError } from "./api.ts";

export { PLUGIN_PERMISSIONS };
export type { PluginFacet, PluginPermission, PluginSlot };

export type PluginTrustView = "first-party" | "user" | "unknown";
export type PluginStateView = "untrusted" | "incompatible" | "disabled" | "starting" | "running" | "stopped" | "failed" | "enabled";

export type PluginView = {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher: { id: string; name: string };
  keyId: string;
  trust: PluginTrustView;
  executable: boolean;
  permissions: PluginPermission[];
  granted: PluginPermission[];
  provides: Array<{ slot: PluginSlot; id: string }>;
  facets: PluginFacet[];
  enabled: boolean;
  state: PluginStateView;
  error: string | null;
  previousVersion: string | null;
  installedAt: string;
  signedAt: string;
  dataBytes: number;
};
export type PluginLeftoverView = { pluginId: string; name: string; uninstalledAt: string; bytes: number };
export type PluginListView = { plugins: PluginView[]; leftovers: PluginLeftoverView[] };
export type BundledPluginView = { id: string; name: string; version: string; description: string; publisher: { id: string; name: string }; installed: boolean; installedVersion: string | null; trust: PluginTrustView; fileName: string };
export type PluginInspectionView = {
  manifest: { id: string; name: string; version: string; description: string; publisher: { id: string; name: string }; permissions: PluginPermission[]; provides: Array<{ slot: PluginSlot; id: string }>; facets: PluginFacet[] };
  executable: boolean;
  keyId: string;
  fingerprint: string | null;
  trust: PluginTrustView;
  signatureValid: boolean | null;
  hostCompatible: boolean;
  action: "install" | "upgrade" | "same-version" | "older";
  installedVersion: string | null;
  newPermissions: PluginPermission[];
  refusal: { reason: string; message: string } | null;
};
export type TrustedKeyView = { keyId: string; label: string; trust: "first-party" | "user"; fingerprint: string; addedAt: string | null };

const REASONS: readonly string[] = PLUGIN_REFUSALS;
const EXTRA_REASONS = ["empty", "start", "plugin"] as const;

/** One sentence for why a plugin request was refused, in words that say what to do about it; nothing in it names a file or a path. */
export function pluginReasonKey(error: CommandError | { details?: unknown }): MessageKey | null {
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  return reason && (REASONS.includes(reason) || (EXTRA_REASONS as readonly string[]).includes(reason)) ? (`plugins.reason.${reason}` as MessageKey) : null;
}

/** The size of what a plugin kept, as a person reads it. */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Whether the plugin can be turned on from the page: not while its publisher is untrusted or it does not fit this version. */
export const canEnable = (plugin: PluginView): boolean => plugin.state !== "untrusted" && plugin.state !== "incompatible";
