import { useState } from "react";
import { Columns2, Maximize2, Minimize2, Minus, MoreHorizontal, Plus, Square } from "lucide-react";
import { READING_THEMES } from "@manga/contracts/reading";
import type { Translator } from "@manga/i18n";
import { FONT_PRESETS } from "@manga/contracts/reading";
import { THEME_BACKGROUND, THEME_FOREGROUND, isPreset, useInstalledFonts } from "./fonts.ts";

type T = Translator["t"];

export type ReaderStyle = {
  measurePx: number;
  fontSizePx: number;
  fontFamily?: string;
  lineHeight: number;
  marginPx: number;
  theme: string;
  paragraphSpacingPx?: number;
  pageMode?: "single" | "double";
  pageRatio?: "book" | "free";
};

const THEME_LABEL = { white: "reading.themeWhite", paper: "reading.themePaper", green: "reading.themeGreen", teal: "reading.themeTeal", night: "reading.themeNight" } as const;

/** Reader controls: font size, family, the five backgrounds, single or double page and full screen; what is set once and rarely changed (width, margins, ratio) sits behind "…". */
export function ReaderToolbar(props: {
  t: T;
  style: ReaderStyle;
  onStyle: (patch: Partial<ReaderStyle>) => void;
  /** Double pages need a text view; a page-image view is shown as it is. */
  canDouble: boolean;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  const { t, style } = props;
  const [more, setMore] = useState(false);
  const fonts = useInstalledFonts();
  const family = style.fontFamily ?? "sans";
  const known = isPreset(family) || fonts.families.includes(family);
  const double = (style.pageMode ?? "single") === "double";
  return (
    <div className="reader-toolbar" role="toolbar" aria-label={t("reader.toolbar")} data-testid="reading-style">
      <div className="reader-group">
        <button type="button" className="icon-button" data-testid="reading-font-smaller" aria-label={t("reader.fontSmaller")} disabled={style.fontSizePx <= 14} onClick={() => props.onStyle({ fontSizePx: Math.max(14, style.fontSizePx - 1) })}><Minus size={16} /></button>
        <span className="reader-size" data-testid="reading-font-size-value" aria-live="polite">{style.fontSizePx}</span>
        <button type="button" className="icon-button" data-testid="reading-font-larger" aria-label={t("reader.fontLarger")} disabled={style.fontSizePx >= 32} onClick={() => props.onStyle({ fontSizePx: Math.min(32, style.fontSizePx + 1) })}><Plus size={16} /></button>
      </div>
      <label className="reader-group">
        <span className="sr-only">{t("reading.fontFamily")}</span>
        <select
          data-testid="reading-font-family"
          value={family}
          onFocus={fonts.load}
          onMouseDown={fonts.load}
          onChange={(event) => props.onStyle({ fontFamily: event.target.value })}
        >
          <optgroup label={t("reader.fontPresets")}>
            {FONT_PRESETS.map((preset) => <option key={preset} value={preset}>{t(`reading.font${preset[0]!.toUpperCase()}${preset.slice(1)}` as "reading.fontSans")}</option>)}
          </optgroup>
          {!known ? <option value={family}>{family}</option> : null}
          {fonts.families.length ? (
            <optgroup label={t("reader.fontInstalled")}>
              {fonts.families.map((name) => <option key={name} value={name}>{name}</option>)}
            </optgroup>
          ) : null}
        </select>
      </label>
      <div className="reader-group reader-themes" role="group" aria-label={t("reader.background")}>
        {READING_THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            className="reader-swatch"
            data-testid={`reading-theme-${theme}`}
            data-current={style.theme === theme}
            aria-pressed={style.theme === theme}
            aria-label={t(THEME_LABEL[theme])}
            title={t(THEME_LABEL[theme])}
            style={{ background: THEME_BACKGROUND[theme], color: THEME_FOREGROUND[theme] }}
            onClick={() => props.onStyle({ theme })}
          >A</button>
        ))}
      </div>
      <div className="reader-group" role="group" aria-label={t("reader.pageMode")}>
        <button type="button" className="icon-button" data-testid="reading-mode-single" aria-pressed={!double} aria-label={t("reader.single")} title={t("reader.single")} onClick={() => props.onStyle({ pageMode: "single" })}><Square size={16} /></button>
        <button type="button" className="icon-button" data-testid="reading-mode-double" aria-pressed={double} aria-label={t("reader.double")} title={t("reader.double")} disabled={!props.canDouble} onClick={() => props.onStyle({ pageMode: "double" })}><Columns2 size={16} /></button>
      </div>
      <button type="button" className="icon-button" data-testid="reading-fullscreen" aria-pressed={props.fullscreen} aria-label={t("reader.fullscreen")} title={t("reader.fullscreen")} onClick={props.onFullscreen}>{props.fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
      <button type="button" className="icon-button" data-testid="reading-more-settings" aria-expanded={more} aria-label={t("reader.moreSettings")} title={t("reader.moreSettings")} onClick={() => setMore((open) => !open)}><MoreHorizontal size={16} /></button>
      {more ? (
        <div className="reader-more" data-testid="reading-more-panel">
          <label className="reader-range">{t("reading.measure")}
            <input type="range" min={360} max={1200} step={10} value={style.measurePx} data-testid="reading-measure" onChange={(event) => props.onStyle({ measurePx: Number(event.target.value) })} />
            <span data-testid="reading-measure-value" className="reader-size">{style.measurePx}</span>
          </label>
          <button type="button" className="secondary-button reader-ratio" data-testid="reading-ratio" aria-pressed={(style.pageRatio ?? "book") === "book"} disabled={!double} onClick={() => props.onStyle({ pageRatio: (style.pageRatio ?? "book") === "book" ? "free" : "book" })}>{t("reader.ratio")}</button>
          <label className="reader-range">{t("reading.lineHeight")}
            <input type="range" min={120} max={240} value={Math.round(style.lineHeight * 100)} data-testid="reading-line-height" onChange={(event) => props.onStyle({ lineHeight: Number(event.target.value) / 100 })} />
            <span data-testid="reading-line-height-value" className="reader-size">{style.lineHeight.toFixed(2)}</span>
          </label>
          <label className="reader-range">{t("reading.margin")}
            <input type="range" min={0} max={96} value={style.marginPx} data-testid="reading-margin" onChange={(event) => props.onStyle({ marginPx: Number(event.target.value) })} />
            <span data-testid="reading-margin-value" className="reader-size">{style.marginPx}</span>
          </label>
          <label className="reader-range">{t("reader.paragraph")}
            <input type="range" min={0} max={40} value={style.paragraphSpacingPx ?? 0} data-testid="reading-paragraph" onChange={(event) => props.onStyle({ paragraphSpacingPx: Number(event.target.value) })} />
            <span data-testid="reading-paragraph-value" className="reader-size">{style.paragraphSpacingPx ?? 0}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
