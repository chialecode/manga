import { useEffect, useState } from "react";
import type { MessageKey } from "@manga/i18n";
import { attempt } from "../lib/api.ts";
import { profilePatch } from "../lib/model-profile.ts";
import type { ConnectionForm } from "../lib/types.ts";
import type { MigrationPlan } from "../pages/settings/general-page.tsx";
import type { PlainTestResult, SaveConnectionResult } from "../pages/settings/connection-dialog.tsx";
import type { SettingsViewProps } from "../pages/settings/settings-view.tsx";
import type { Services } from "./services.tsx";

/**
 * What the settings pages do through the application: choosing where the data lives, applying a move, connections to models, the inventory. Moved out of
 * the shell so the settings tab can bring them with it; the state they hold (a move being confirmed, the inventory) lives as long as the tab shows it.
 */
export function useSettingsActions(s: Services, active: boolean) {
  const { t } = s;
  const [migration, setMigration] = useState<MigrationPlan | null>(null);
  const [inventory, setInventory] = useState<Record<string, unknown> | null>(null);

  // The inventory is read when the page that shows it is open, not on every refresh.
  useEffect(() => {
    if (!active) return;
    void attempt("inventory.overview").then((inv) => { if (inv.ok) setInventory(inv.value); });
  }, [active, s.shelfKey]);

  async function failing(commandId: string, input: unknown = {}): Promise<boolean> {
    const result = await attempt(commandId, input);
    if (!result.ok) s.setError(result.error.message);
    return result.ok;
  }

  async function chooseLocation() {
    const handle = await window.manga.chooseDirectory();
    if (!handle) return;
    const proposed = await attempt("settings.proposeLocations", { pathHandle: handle });
    if (!proposed.ok) { s.setError(proposed.error.message); return; }
    const copies = (proposed.value.copies as Array<{ partition: string; bytes: number; target: string }> | undefined) ?? [];
    s.setError(undefined);
    setMigration({ handle, checkpointId: String(proposed.value.checkpointId ?? ""), copies });
  }

  async function applyMigration() {
    if (!migration) return;
    const applied = await attempt("settings.applyLocations", { checkpointId: migration.checkpointId, pathHandle: migration.handle });
    if (!applied.ok) s.setError(applied.error.message);
    else { s.setError(undefined); s.setNotice(t("settings.migrationDone")); }
    setMigration(null);
    await s.refresh();
  }

  /** Saves in one command so a refused number leaves nothing half saved; the answer goes back to the dialog, which shows it beside the form. */
  async function saveConnection(fields: ConnectionForm): Promise<SaveConnectionResult> {
    // Only what the person changed in the model's numbers and switches is saved as theirs; a number left alone keeps where it came from.
    const patch = fields.profile && fields.profileBefore ? profilePatch(fields.profileBefore, fields.profile) : {};
    const credentialHandle = fields.secret ? await window.manga.stashSecret(fields.secret) : undefined;
    const saved = await attempt<{ id: string }>("connections.upsert", {
      id: fields.id,
      label: fields.label,
      protocol: fields.protocol,
      runtime: fields.runtime,
      baseUrl: fields.baseUrl,
      modelId: fields.modelId,
      purpose: fields.purpose,
      timeoutMs: Number(fields.timeoutMs) || 60_000,
      credentialHandle,
      ...(Object.keys(patch).length > 0 && (fields.purpose === "text" || fields.purpose === "vision") ? { profile: patch } : {}),
    });
    if (!saved.ok) return { ok: false, message: saved.error.message };
    s.setError(undefined);
    s.setNotice(t("settings.connectionSaved"));
    await s.refresh();
    return { ok: true, id: saved.value.id };
  }

  /** A test of a connection that is not asked questions, answered in words about what to fix rather than as a code. */
  async function testPlainConnection(connectionId: string, capability: string): Promise<PlainTestResult> {
    const result = await attempt("connections.test", { connectionId, capability });
    await s.refresh();
    if (result.ok) return { ok: true, message: t("models.plain.ok") };
    const { code } = result.error;
    const status = Number((result.error.details as { status?: unknown } | undefined)?.status ?? 0);
    const reason = code === "AUTHENTICATION_FAILED" || status === 401 || status === 403 ? "auth"
      : status === 404 ? "address"
      : code === "MODEL_CAPABILITY_MISSING" ? "capability"
      : code === "PROVIDER_UNAVAILABLE" || code === "CANCELLED" ? "network"
      : "other";
    return { ok: false, message: t("models.plain.fail", { message: t(`models.plain.reason.${reason}` as MessageKey) }) };
  }

  /** One question to the model; what it found and what failed is kept with the connection and shown under it. */
  async function probeConnection(connectionId: string) {
    const result = await attempt("connections.probe", { connectionId });
    if (!result.ok) s.setError(result.error.message);
    await s.refresh();
  }

  const general: SettingsViewProps["general"] = {
    onChooseLocation: () => void chooseLocation(),
    onPointerLocation: () => void window.manga.chooseDirectory().then(async (handle) => {
      if (!handle) return;
      await failing("settings.setLayout", { pointerPathHandle: handle });
      await s.refresh();
    }),
    onIndexedRoot: () => void window.manga.chooseDirectory().then(async (handle) => {
      if (!handle) return;
      await failing("library.indexExternal", { pathHandle: handle });
      await s.refresh();
    }),
    onApplyMigration: () => void applyMigration(),
    onCancelMigration: () => setMigration(null),
    onRollbackRecovery: () => void failing("settings.recoverJobs", { action: "rollback" }).then(() => s.refresh()),
    onRecoverJobs: () => void failing("settings.recoverJobs", { action: "recover" }).then(() => s.refresh()),
  };
  const models: SettingsViewProps["models"] = {
    onRuntime: async (runtime) => { await failing("settings.setRuntime", { runtime }); await s.refresh(); },
    onSaveConnection: saveConnection,
    onDeleteConnection: async (connectionId) => { if (await failing("connections.delete", { connectionId })) s.setNotice(t("models.deleted")); await s.refresh(); },
    onProbeConnection: probeConnection,
    onTestConnection: testPlainConnection,
    onSkip: () => void attempt("settings.skipAi").then(() => s.refresh()),
  };
  const storage: SettingsViewProps["storage"] = {
    onScan: () => void attempt("inventory.scan").then((item) => setInventory(item.ok ? item.value : null)),
    onCancelScan: () => void attempt("inventory.cancelScan", { scanId: "current" }),
    onReveal: (itemId) => void window.manga.reveal(itemId).then((result) => { if (result.status === "error") s.setError(result.error?.message); }),
    onRepair: (itemId) => void failing("inventory.repair", { id: itemId }).then((ok) => { if (ok) void s.refresh(); }),
    onOpenCategory: (category) => s.open.library(category),
  };
  return { migration, inventory, general, models, storage };
}
