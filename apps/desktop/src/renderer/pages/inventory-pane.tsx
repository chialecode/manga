import { useState } from "react";
import type { Translator } from "@manga/i18n";

type I18n = Translator;

type Row = Record<string, unknown>;
const FILTERS = ["all", "resource", "comic", "video", "recording", "cover", "note", "storage"] as const;
type Filter = (typeof FILTERS)[number];

/** Which filter an overview row belongs to; the flat storage rows (partitions, attachments, indexed folders) share one. */
function groupOf(item: Row): Filter {
  if (item.kind === "resource") return "resource";
  if (item.kind === "note") return "note";
  if (item.kind === "recording") return "recording";
  if (item.kind === "media-category") return item.category === "playCopy" ? "video" : (String(item.category) as Filter);
  return "storage";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function InventoryPane(props: {
  i18n: I18n;
  inventory: Record<string, unknown> | null;
  onScan: () => void;
  onCancel: () => void;
  onTranscribe: () => void;
  onReveal: (id: string) => void;
  onRepair: (id: string) => void;
  /** Opens the shelf that manages a category; the recording, cover and copy categories have no page of their own. */
  onOpenCategory?: (category: "comic" | "video") => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const items = (props.inventory?.items as Array<Row> | undefined) ?? [];
  const totals = props.inventory?.totals as Record<string, { count?: number; bytes?: number }> | undefined;
  const categories = items.filter((item) => item.kind === "media-category");
  const shown = items.filter((item) => item.kind !== "media-category" && (filter === "all" || groupOf(item) === filter));
  return (
    <section>
      <div className="flex gap-2 mb-3 flex-wrap">
        <button className="border px-3 py-1 rounded" onClick={props.onScan}>{props.i18n.t("library.scan")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onCancel}>{props.i18n.t("library.cancelScan")}</button>
        <button className="border px-3 py-1 rounded" onClick={props.onTranscribe}>{props.i18n.t("library.transcribe")}</button>
      </div>
      {categories.length ? (
        <section className="mb-3" data-testid="inventory-categories" aria-label={props.i18n.t("inv.categories")}>
          <h2 className="font-medium mb-1">{props.i18n.t("inv.categories")}</h2>
          <ul className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]">
            {categories.map((item) => {
              const id = String(item.category);
              const hosted = Number((totals?.[id] as { hosted?: number } | undefined)?.hosted ?? item.count);
              const managed = id === "comic" || id === "video";
              return (
                <li key={String(item.id)} className="border border-[var(--color-border)] rounded p-2 bg-[var(--color-surface)]" data-testid={`inv-cat-${id}`} data-status={String(item.status)}>
                  <div className="font-medium">{props.i18n.t(`inv.category.${id}` as never)}</div>
                  <div className="text-sm" data-testid={`inv-cat-${id}-summary`}>{props.i18n.t("inv.category.summary", { count: Number(item.count ?? 0), bytes: formatSize(Number(item.bytes ?? 0)) })}</div>
                  {managed && item.indexed ? <div className="text-sm text-[var(--color-subtle)]">{props.i18n.t("inv.category.hosted", { hosted })}</div> : null}
                  {item.moduleEnabled === false ? <div className="text-sm text-[var(--color-subtle)]" data-testid={`inv-cat-${id}-disabled`}>{props.i18n.t("inv.category.disabled")}</div> : null}
                  {Number(item.missing ?? 0) > 0 ? <div className="text-sm" role="status" data-testid={`inv-cat-${id}-missing`}>{props.i18n.t("inv.category.missing", { count: Number(item.missing) })}</div> : null}
                  <div className="flex gap-2 mt-1 flex-wrap">
                    <button className="text-sm border px-2 py-0.5 rounded" data-testid={`inv-filter-${id}`} onClick={() => setFilter((id === "playCopy" ? "video" : id) as Filter)}>{props.i18n.t("inv.show")}</button>
                    {managed && item.moduleEnabled !== false && props.onOpenCategory ? <button className="text-sm border px-2 py-0.5 rounded" data-testid={`inv-open-${id}`} onClick={() => props.onOpenCategory!(id as "comic" | "video")}>{props.i18n.t("inv.open")}</button> : null}
                    {item.revealable ? <button className="text-sm border px-2 py-0.5 rounded" data-testid={`inv-reveal-${id}`} onClick={() => props.onReveal(String(item.id))}>{props.i18n.t("library.reveal")}</button> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <div className="flex gap-1 mb-2 flex-wrap" role="group" aria-label={props.i18n.t("inv.filter")} data-testid="inventory-filters">
        {FILTERS.map((name) => (
          <button key={name} className={`text-sm border px-2 py-0.5 rounded ${filter === name ? "bg-[var(--color-accent-soft)]" : ""}`} aria-pressed={filter === name} data-testid={`inv-filter-chip-${name}`} onClick={() => setFilter(name)}>{props.i18n.t(`inv.filter.${name}` as never)}</button>
        ))}
      </div>
      {totals ? <p className="text-sm text-[var(--color-subtle)] mb-2">{props.i18n.t("library.count", { count: Number(totals.resource?.count ?? 0) })} · {props.i18n.t("library.bytes", { value: Number(totals.resource?.bytes ?? 0) })}</p> : null}
      {totals && Number(totals.resource?.count ?? 0) > items.filter((item) => item.kind === "resource").length ? (
        <p className="text-sm text-[var(--color-subtle)] mb-2" data-testid="library-window">{props.i18n.t("library.recentWindow", { listed: items.filter((item) => item.kind === "resource").length, count: Number(totals.resource?.count ?? 0) })}</p>
      ) : null}
      {shown.length === 0 ? <p data-testid="inventory-empty">{props.i18n.t("status.empty")}</p> : (
        <ul className="space-y-2" data-testid="inventory-list">
          {shown.map((item) => (
            <li key={String(item.id)} className="border border-[var(--color-border)] rounded p-2 bg-[var(--color-surface)]">
              <div>{String(item.title)}</div>
              <div className="text-sm text-[var(--color-subtle)]">{item.kind === "recording" ? props.i18n.t("inv.recording.item", { duration: clock(Number(item.durationMs ?? 0)) }) : String(item.kind)}{item.status === "cleaned" ? ` · ${props.i18n.t("inv.recording.cleaned")}` : ""}{item.moduleEnabled === false ? ` · ${props.i18n.t("inv.category.disabled")}` : ""} · {item.hosted ? props.i18n.t("library.hosted") : props.i18n.t("library.indexed")} · {item.available === false ? props.i18n.t("library.unavailable") : props.i18n.t("library.available")} · {props.i18n.t("library.bytes", { value: Number(item.bytes ?? 0) })}</div>
              {item.revealable ? <button className="text-sm mt-1 border px-2 py-0.5 rounded" onClick={() => props.onReveal(String(item.id))}>{props.i18n.t("library.reveal")}</button> : null}
              {item.available === false ? <button className="text-sm mt-1 ml-2 border px-2 py-0.5 rounded" onClick={() => props.onRepair(String(item.id))}>{props.i18n.t("library.repair")}</button> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
