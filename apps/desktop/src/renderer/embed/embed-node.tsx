import { createContext, useContext } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ExternalLink, Layers, RefreshCw, Trash2 } from "lucide-react";
import type { EmbedAttr, EmbedHost, EmbedItem } from "./embed-types.ts";

/** The note editor offers the host of the note's embeds through this, so the node view of a block does not need its own plumbing. */
export const EmbedHostContext = createContext<EmbedHost | null>(null);

/** One embed block of a note: an atom that is saved as a block of type `embed` carrying what it points at. */
export const MangaEmbed = Node.create({
  name: "mangaEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { blockId: { default: "b1" }, anchorId: { default: null }, embed: { default: null } };
  },
  parseHTML: () => [{ tag: "div[data-embed-block]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes({ "data-embed-block": "true", "data-block-id": HTMLAttributes.blockId })],
  addNodeView() {
    return ReactNodeViewRenderer(EmbedNodeView);
  },
});

function EmbedNodeView(props: NodeViewProps) {
  const host = useContext(EmbedHostContext);
  const blockId = String(props.node.attrs.blockId ?? "");
  const attr = props.node.attrs.embed as EmbedAttr | null;
  return (
    <NodeViewWrapper className="embed-block" data-testid={`block-${blockId}`} data-block-id={blockId} contentEditable={false}>
      <EmbedCard blockId={blockId} attr={attr} host={host} selected={props.selected} />
    </NodeViewWrapper>
  );
}

/** The card of an embed. It never throws on a bad target: every state has a title, a line of text and the actions that make sense for it. */
export function EmbedCard(props: { blockId: string; attr: EmbedAttr | null; host: EmbedHost | null; selected?: boolean }) {
  const { host, attr, blockId } = props;
  if (!host) return <div className="embed-card" data-embed-state="valid" data-testid={`embed-${blockId}`}><span className="detail-muted">{attr?.label ?? ""}</span></div>;
  const { t } = host;
  const item: EmbedItem | undefined = host.items[blockId];
  const kind = item?.targetKind ?? attr?.kind ?? "note";
  const state = item?.state ?? "valid";
  const mode = item?.mode ?? attr?.mode ?? "live";
  const title = item?.title || attr?.label || t("embed.untitled");
  const recovery = item?.recovery ?? [];
  return (
    <div className="embed-card" data-testid={`embed-${blockId}`} data-embed-state={state} data-embed-kind={kind} data-selected={props.selected ? "true" : "false"}>
      <div className="embed-head">
        <Layers size={14} aria-hidden="true" />
        <span className="chip">{t(`embed.insert.kind.${kind}` as never)}</span>
        <strong className="embed-title" data-testid={`embed-title-${blockId}`}>{title}</strong>
        <span className="chip embed-mode" data-testid={`embed-mode-${blockId}`}>{t(`embed.mode.${mode}` as never)}</span>
        {state !== "valid" ? <span className="chip embed-state" role="status" data-testid={`embed-state-${blockId}`}>{t(`embed.state.${state}` as never)}</span> : null}
      </div>
      {item ? <p className="embed-summary" data-testid={`embed-summary-${blockId}`}>{item.summary || t("embed.summary.empty")}</p> : <p className="embed-summary detail-muted">{t("embed.pending")}</p>}
      {item?.mode === "snapshot" && item.takenAt ? <p className="detail-muted embed-taken" data-testid={`embed-taken-${blockId}`}>{t("embed.snapshotAt", { time: host.formatDate(item.takenAt) })}</p> : null}
      <div className="embed-actions">
        {recovery.includes("open") ? <button type="button" className="secondary-button" data-testid={`embed-open-${blockId}`} onClick={() => item && host.onOpen(item)}><ExternalLink size={13} aria-hidden="true" /> {t("embed.open")}</button> : null}
        {recovery.includes("enable") ? <button type="button" className="secondary-button" data-testid={`embed-enable-${blockId}`} onClick={() => item && host.onEnable(item)}>{t("embed.enable")}</button> : null}
        {recovery.includes("refresh") ? <button type="button" className="secondary-button" data-testid={`embed-refresh-${blockId}`} onClick={() => host.onRefresh(blockId)}><RefreshCw size={13} aria-hidden="true" /> {t("embed.refresh")}</button> : null}
        {recovery.includes("keepSnapshot") ? <button type="button" className="secondary-button" data-testid={`embed-keep-${blockId}`} onClick={() => item && host.onKeepSnapshot(blockId, item)}>{t("embed.keepSnapshot")}</button> : null}
        <button type="button" className="secondary-button" data-testid={`embed-remove-${blockId}`} onClick={() => host.onRemove(blockId)}><Trash2 size={13} aria-hidden="true" /> {t("embed.remove")}</button>
      </div>
    </div>
  );
}
