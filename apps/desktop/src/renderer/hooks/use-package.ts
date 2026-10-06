import { useState } from "react";
import type { Translator } from "@manga/i18n";
import { attempt, call, CommandError, messageOf } from "../lib/api.ts";

export type PackageStrategy = "skip" | "replace" | "duplicate";
export type PackagePreview = {
  counts: Record<string, number>;
  empty: boolean;
  conflicts: Array<{ kind: string; id: string; label: string; reason: string }>;
  missingAttachments: string[];
  defaultStrategy: PackageStrategy;
};

/** Export the whole library, or preview and apply a data package with the user's per-conflict choices. */
export function usePackage(deps: { i18n: Translator; setError: (message?: string) => void; setNotice: (message?: string) => void; refresh: () => Promise<void> }) {
  const { i18n, setError, setNotice, refresh } = deps;
  const [preview, setPreview] = useState<PackagePreview | null>(null);
  const [handle, setHandle] = useState<string>();
  const [strategy, setStrategy] = useState<PackageStrategy>("duplicate");
  const [decisions, setDecisions] = useState<Record<string, PackageStrategy>>({});
  /** Covers go into a backup by default (A-51); the choice is kept for the session. */
  const [includeCovers, setIncludeCovers] = useState(true);
  const [exporting, setExporting] = useState(false);

  function decide(kind: string, rowId: string, action: PackageStrategy | null) {
    setDecisions((current) => {
      const next = { ...current };
      if (action) next[`${kind}:${rowId}`] = action;
      else delete next[`${kind}:${rowId}`];
      return next;
    });
  }

  function cancel() {
    setPreview(null);
    setHandle(undefined);
    setDecisions({});
  }

  /** Write the whole library, reading state included, so the round trip can be checked from the UI. It can be cancelled while it runs. */
  async function exportPackage() {
    const target = await window.manga.chooseDirectory();
    if (!target) return;
    setExporting(true);
    try {
      await call("library.exportPackage", { pathHandle: target, includeCovers });
    } catch (error) {
      setExporting(false);
      if (error instanceof CommandError && error.code === "CANCELLED") setNotice(i18n.t("settings.packageExportCancelled"));
      else setError(messageOf(error));
      return;
    }
    setExporting(false);
    setNotice(i18n.t("settings.packageExported"));
    await refresh();
  }

  async function cancelExport() {
    await attempt("library.cancelExport");
  }

  async function previewPackage() {
    const target = await window.manga.chooseDirectory();
    if (!target) return;
    try {
      const value = await call<PackagePreview>("package.preview", { pathHandle: target });
      setHandle(target);
      setStrategy(value.defaultStrategy ?? "duplicate");
      setDecisions({});
      setPreview(value);
    } catch (error) {
      setError(messageOf(error));
    }
  }

  async function applyImport() {
    if (!handle) return;
    const rows = Object.entries(decisions).map(([key, action]) => {
      const separator = key.indexOf(":");
      return { kind: key.slice(0, separator), id: key.slice(separator + 1), action };
    });
    try {
      await call("package.importResolved", { pathHandle: handle, strategy, ...(rows.length ? { decisions: rows } : {}) });
    } catch (error) {
      setError(messageOf(error));
      return;
    }
    setNotice(i18n.t("settings.packageImported"));
    cancel();
    await refresh();
  }

  return { preview, strategy, setStrategy, decisions, decide, cancel, exportPackage, cancelExport, exporting, includeCovers, setIncludeCovers, previewPackage, applyImport };
}

export type PackageFlow = ReturnType<typeof usePackage>;
