import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { ExternalLink, Trash2 } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { asArray, attempt } from "../lib/api.ts";
import { Modal } from "../components/modal.tsx";
import { ScreenshotThumb } from "../components/screenshot-thumb.tsx";

type T = Translator["t"];

/** What a note's screenshot blocks need from the page: the words, going back to the source, and taking the block out. */
export type ScreenshotHost = { t: T; onOpen: (screenshotId: string) => void; onRemove: (blockId: string) => void };
export const ScreenshotHostContext = createContext<ScreenshotHost | null>(null);

type Info = { title: string; mediaKind: "video" | "comic"; positionMs: number | null; pageLabel: string | null; subtitleText: string | null; width: number; height: number; available: boolean };

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
};

/** One screenshot of a note: an atom saved as a block of type `screenshot` that holds only the id; the picture stays in the folder of its work. */
export const MangaScreenshot = Node.create({
  name: "mangaScreenshot",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { blockId: { default: "b1" }, anchorId: { default: null }, screenshotId: { default: "" } };
  },
  parseHTML: () => [{ tag: "div[data-screenshot-block]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes({ "data-screenshot-block": "true", "data-block-id": HTMLAttributes.blockId })],
  addNodeView() {
    return ReactNodeViewRenderer(ScreenshotNodeView);
  },
});

function ScreenshotNodeView(props: NodeViewProps) {
  const host = useContext(ScreenshotHostContext);
  const blockId = String(props.node.attrs.blockId ?? "");
  const screenshotId = String(props.node.attrs.screenshotId ?? "");
  const [info, setInfo] = useState<Info | "gone" | null>(null);
  useEffect(() => {
    let live = true;
    void attempt<{ screenshot: Info }>("screenshot.get", { screenshotId }).then((result) => { if (live) setInfo(result.ok ? result.value.screenshot : "gone"); });
    return () => { live = false; };
  }, [screenshotId]);
  const gone = info === "gone" || (info !== null && !info.available);
  const place = info && info !== "gone" ? (info.mediaKind === "video" && info.positionMs !== null ? clock(info.positionMs) : info.pageLabel ? `P${info.pageLabel}` : "") : "";
  return (
    <NodeViewWrapper className="embed-block screenshot-block" data-testid={`block-${blockId}`} data-block-id={blockId} contentEditable={false}>
      <figure className="screenshot-card" data-testid={`screenshot-${blockId}`} data-state={gone ? "gone" : "valid"} data-selected={props.selected ? "true" : "false"}>
        {gone || !host ? <div className="screenshot-gone detail-muted" role="status">{host?.t("screenshot.block.gone") ?? ""}</div> : <ScreenshotThumb screenshotId={screenshotId} alt={host.t("screenshot.thumb")} className="screenshot-image" />}
        {info && info !== "gone" ? (
          <figcaption>
            <strong data-testid={`screenshot-title-${blockId}`}>{info.title}</strong>
            {place ? <span className="chip">{place}</span> : null}
            {info.subtitleText ? <span className="detail-muted screenshot-line">{info.subtitleText}</span> : null}
          </figcaption>
        ) : null}
        {host ? (
          <div className="embed-actions">
            {!gone ? <button type="button" className="secondary-button" data-testid={`screenshot-open-${blockId}`} onClick={() => host.onOpen(screenshotId)}><ExternalLink size={13} aria-hidden="true" /> {host.t("screenshot.block.open")}</button> : null}
            <button type="button" className="secondary-button" data-testid={`screenshot-remove-${blockId}`} onClick={() => host.onRemove(blockId)}><Trash2 size={13} aria-hidden="true" /> {host.t("embed.remove")}</button>
          </div>
        ) : null}
      </figure>
    </NodeViewWrapper>
  );
}

type Candidate = { id: string; title: string };

/** Choose one of the screenshots to put into the note: the newest first, with their pictures. */
export function ScreenshotPicker(props: { t: T; onPick: (screenshotId: string) => void; onClose: () => void }) {
  const { t } = props;
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    void attempt<{ items: Candidate[] }>("screenshot.list", { limit: 200 }).then((result) => { if (live) setItems(result.ok ? asArray<Candidate>(result.value.items) : []); });
    return () => { live = false; };
  }, []);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter((item) => !needle || item.title.toLowerCase().includes(needle));
  }, [items, query]);
  return (
    <Modal title={t("screenshot.block.pick")} closeLabel={t("common.close")} onClose={props.onClose} testId="screenshot-picker">
      <div className="ref-picker">
        <input type="search" data-testid="screenshot-search" value={query} placeholder={t("whiteboard.ref.search")} aria-label={t("whiteboard.ref.search")} onChange={(event) => setQuery(event.target.value)} autoFocus />
        {items === null ? <p className="detail-muted">{t("status.loading")}</p> : null}
        {items && !items.length ? <p className="detail-muted" data-testid="screenshot-empty">{t("screenshot.block.empty")}</p> : null}
        <ul className="ref-list">
          {shown.map((item) => (
            <li key={item.id}>
              <button type="button" data-testid={`screenshot-pick-${item.id}`} onClick={() => props.onPick(item.id)}>
                <ScreenshotThumb screenshotId={item.id} alt={t("screenshot.thumb")} />
                <span className="ref-label">{item.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
