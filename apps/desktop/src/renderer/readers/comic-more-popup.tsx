import { useLayoutEffect, useRef, type RefObject } from "react";
import { Columns2, Pause, Play, ScrollText, Square } from "lucide-react";
import type { Translator } from "@manga/i18n";
import { Popup } from "../components/popup.tsx";
import type { ComicAnimation, ComicDirection, ComicLayout } from "./comic-model.ts";
import { MatchLink } from "./match-link.tsx";

type T = Translator["t"];

export function ComicMorePopup(props: {
  t: T;
  anchor: RefObject<HTMLElement | null>;
  layout: ComicLayout;
  reading: ComicDirection;
  coverAlone: boolean;
  autoOn: boolean;
  autoFlipSeconds: number;
  animation: ComicAnimation;
  onClose: () => void;
  onDirection: (direction: ComicDirection) => void;
  onLayout: (layout: ComicLayout) => void;
  onCoverAlone: (value: boolean) => void;
  onToggleAutoFlip: () => void;
  onAutoFlipSeconds: (seconds: number) => void;
  onAnimation: (animation: ComicAnimation) => void;
  onMatch?: () => void;
}) {
  const { t, layout, reading } = props;
  const boxRef = useRef<HTMLDivElement>(null);

  // Keep native top-layer anchor positioning above the legacy absolute rules on `.reader-more-pop`.
  useLayoutEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    node.style.position = "fixed";
    node.style.inset = "auto";
  }, []);

  return (
    <Popup
      anchor={props.anchor}
      boxRef={boxRef}
      onClose={props.onClose}
      placement="above"
      align="end"
      role="group"
      label={t("comic.settings")}
      className="reader-more reader-more-pop reader-more-up"
      testId="comic-more-panel"
    >
      <div className="reader-group" role="group" aria-label={t("comic.layout")}>
        <button type="button" className="icon-button" data-testid="comic-layout-single" aria-pressed={layout === "single"} aria-label={t("comic.layoutSingle")} title={t("comic.layoutSingle")} onClick={() => props.onLayout("single")}><Square size={16} /></button>
        <button type="button" className="icon-button" data-testid="comic-layout-double" aria-pressed={layout === "double"} aria-label={t("comic.layoutDouble")} title={t("comic.layoutDouble")} onClick={() => props.onLayout("double")}><Columns2 size={16} /></button>
        <button type="button" className="icon-button" data-testid="comic-layout-strip" aria-pressed={layout === "strip"} aria-label={t("comic.layoutStrip")} title={t("comic.layoutStrip")} onClick={() => props.onLayout("strip")}><ScrollText size={16} /></button>
      </div>
      <button
        type="button"
        className="secondary-button"
        data-testid="comic-direction"
        data-direction={reading}
        aria-label={t("comic.direction")}
        title={t("comic.direction")}
        onClick={() => props.onDirection(reading === "rtl" ? "ltr" : "rtl")}
      >{reading === "rtl" ? t("comic.dirRtl") : t("comic.dirLtr")}</button>
      <label className="reader-range">
        <input type="checkbox" data-testid="comic-cover-alone" checked={props.coverAlone} disabled={layout !== "double"} onChange={(event) => props.onCoverAlone(event.target.checked)} />
        {t("comic.coverAlone")}
      </label>
      <div className="reader-group">
        <button type="button" className="icon-button" data-testid="comic-autoflip" aria-pressed={props.autoOn} aria-label={t("comic.autoFlip")} title={t("comic.autoFlip")} onClick={props.onToggleAutoFlip}>{props.autoOn ? <Pause size={16} /> : <Play size={16} />}</button>
        <label className="reader-range">{t("comic.autoFlipSeconds")}
          <input type="number" min={0} max={120} step={1} data-testid="comic-autoflip-seconds" value={props.autoFlipSeconds} onChange={(event) => props.onAutoFlipSeconds(Math.min(120, Math.max(0, Number(event.target.value) || 0)))} />
        </label>
      </div>
      <label className="reader-range">{t("comic.animation")}
        <select data-testid="comic-animation" value={props.animation} onChange={(event) => props.onAnimation(event.target.value as ComicAnimation)}>
          <option value="fade">{t("comic.animFade")}</option>
          <option value="slide">{t("comic.animSlide")}</option>
          <option value="none">{t("comic.animNone")}</option>
        </select>
      </label>
      <MatchLink label={t("match.fromReader")} onMatch={props.onMatch} />
    </Popup>
  );
}
