import { useCallback, useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Menu } from "../components/menu.tsx";
import { asArray, attempt } from "../lib/api.ts";
import type { WorkMediaKind } from "../lib/works.ts";
import { KIND_ICON } from "./work-card.tsx";
import { MoveDialog } from "./move-resource-dialog.tsx";

type T = Translator["t"];

export type UnassignedItem = { resourceId: string; kind: string; title: string; ordinalLabel: string | null; leftWorkAt: string | null; lastOpenedAt: string | null; outside: boolean };

const FIRST = 24;
const asKind = (kind: string): WorkMediaKind => (kind === "comic" || kind === "video" ? kind : "novel");

/**
 * The resources that are in no work (LIB-02, A-87): the ones whose entry was deleted, and the ones taken out of a work. They stay listed at the end of
 * the shelf and open like any other; they can be put in a work, or matched to an online entry, which makes a work for them first.
 */
export function UnassignedGroup(props: {
  t: T;
  /** The shelf of one medium, or `null` on the overview. */
  kind: WorkMediaKind | null;
  /** The shelf's search text, if any. */
  query?: string;
  refreshKey: number;
  onOpenResource: (resourceId: string, kind: WorkMediaKind) => void;
  /** A work was made for the resource; the page that matches it opens. */
  onMatch: (workId: string, kind: WorkMediaKind) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { t } = props;
  const [state, setState] = useState<{ items: UnassignedItem[]; total: number } | null>(null);
  const [all, setAll] = useState(false);
  const [moving, setMoving] = useState<UnassignedItem | null>(null);

  const load = useCallback(async () => {
    const result = await attempt<{ items: UnassignedItem[]; total: number }>("works.unassigned", { ...(props.kind ? { kind: props.kind } : {}), ...(props.query ? { query: props.query } : {}), limit: 200 });
    if (result.ok) setState({ items: asArray<UnassignedItem>(result.value.items), total: typeof result.value.total === "number" ? result.value.total : asArray(result.value.items).length });
  }, [props.kind, props.query]);
  useEffect(() => { void load(); }, [load, props.refreshKey]);

  async function match(item: UnassignedItem) {
    const result = await attempt<{ workId: string }>("works.moveResource", { resourceId: item.resourceId, newWorkTitle: item.title });
    if (!result.ok) { props.onError(result.error.message); return; }
    props.onChanged();
    props.onMatch(result.value.workId, asKind(item.kind));
  }

  if (!state || state.total === 0) return null;
  const shown = all ? state.items : state.items.slice(0, FIRST);
  return (
    <section className="shelf-section unassigned-group" data-testid="unassigned-group" aria-label={t("unassigned.title")}>
      <header>
        <h2>{t("unassigned.title")}<span className="section-count" data-testid="unassigned-count">{t("unassigned.count", { count: state.total })}</span></h2>
      </header>
      <p className="detail-muted">{t("unassigned.hint")}</p>
      <ul className="unassigned-list" data-testid="unassigned-list">
        {shown.map((item) => {
          const kind = asKind(item.kind);
          const Icon = KIND_ICON[kind];
          const label = item.ordinalLabel ? `${item.ordinalLabel} ${item.title}`.trim() : item.title;
          return (
            <li key={item.resourceId} className="unassigned-row" data-testid={`unassigned-${item.resourceId}`} data-kind={kind}>
              <button type="button" className="unassigned-open" data-testid={`unassigned-open-${item.resourceId}`} aria-label={`${t("unassigned.open")}：${label}`} onClick={() => props.onOpenResource(item.resourceId, kind)}>
                <Icon size={16} aria-hidden="true" />
                <span className="unassigned-title" title={label}>{label}</span>
                <span className="detail-muted">{item.leftWorkAt ? t("unassigned.left", { time: item.leftWorkAt.slice(0, 10) }) : t("unassigned.never")}{item.outside ? ` · ${t("card.outside")}` : ""}</span>
              </button>
              <Menu
                label={t("unassigned.menu", { title: label })}
                testId={`unassigned-menu-${item.resourceId}`}
                align="end"
                trigger={<MoreHorizontal size={16} />}
                items={[
                  { id: "assign", label: t("unassigned.assign"), onSelect: () => setMoving(item) },
                  { id: "match", label: t("unassigned.match"), onSelect: () => void match(item) },
                ]}
              />
            </li>
          );
        })}
      </ul>
      {!all && state.items.length > FIRST ? <button type="button" className="link-button" data-testid="unassigned-all" onClick={() => setAll(true)}>{t("unassigned.showAll", { count: state.items.length })}</button> : null}
      {moving ? (
        <MoveDialog
          t={t}
          resourceId={moving.resourceId}
          fromWorkId={null}
          kind={asKind(moving.kind)}
          onClose={() => setMoving(null)}
          onError={props.onError}
          onMoved={() => { setMoving(null); props.onNotice(t("unassigned.assigned")); props.onChanged(); void load(); }}
        />
      ) : null}
    </section>
  );
}
