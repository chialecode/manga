import { useEffect, type ReactNode, type RefObject } from "react";
import { Columns2, Minus, Plus, Square } from "lucide-react";
import { FONT_PRESETS, READING_THEMES } from "@manga/contracts/reading";
import type { Translator } from "@manga/i18n";
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

/**
 * The reading settings of the novel reader (A-63): font, size, line height, margins, paragraph spacing, line width, background and page mode in one
 * panel. A change shows at once and is saved with it. The panel is a popover of the header; Esc or a click outside closes it.
 */
export function ReadingSettings(props: {
  t: T;
  style: ReaderStyle;
  onStyle: (patch: Partial<ReaderStyle>) => void;
  /** Double pages need a text view; a page-image view is shown as it is. */
  canDouble: boolean;
  onClose: () => void;
  /** The button that opened the panel: a click on it is the button's own toggle, not "outside". */
  anchor: RefObject<HTMLElement | null>;
  panel: RefObject<HTMLDivElement | null>;
  /** What else belongs in the "…" panel of the reader, after the settings (the match with an online entry). */
  extra?: ReactNode;
}) {
  const { t, style, onClose, anchor, panel } = props;
  const fonts = useInstalledFonts();
  const family = style.fontFamily ?? "sans";
  const known = isPreset(family) || fonts.families.includes(family);
  const double = (style.pageMode ?? "single") === "double";

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (panel.current?.contains(target) || anchor.current?.contains(target))) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); anchor.current?.focus(); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key); };
  }, [onClose, anchor, panel]);

  return (
    <div ref={panel} className="reader-more reader-more-pop reader-more-up reading-settings" role="group" aria-label={t("reader.settings")} data-testid="reading-settings-panel">
      <div className="reading-setting">
        <span className="reading-setting-name">{t("reading.fontFamily")}</span>
        <select
          data-testid="reading-font-family"
          aria-label={t("reading.fontFamily")}
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
      </div>
      <div className="reading-setting">
        <span className="reading-setting-name">{t("reading.fontSize")}</span>
        <span className="reader-group">
          <button type="button" className="icon-button" data-testid="reading-font-smaller" aria-label={t("reader.fontSmaller")} disabled={style.fontSizePx <= 14} onClick={() => props.onStyle({ fontSizePx: Math.max(14, style.fontSizePx - 1) })}><Minus size={16} /></button>
          <span className="reader-size" data-testid="reading-font-size-value" aria-live="polite">{style.fontSizePx}</span>
          <button type="button" className="icon-button" data-testid="reading-font-larger" aria-label={t("reader.fontLarger")} disabled={style.fontSizePx >= 32} onClick={() => props.onStyle({ fontSizePx: Math.min(32, style.fontSizePx + 1) })}><Plus size={16} /></button>
        </span>
      </div>
      <div className="reading-setting">
        <span className="reading-setting-name">{t("reader.background")}</span>
        <span className="reader-group reader-themes" role="group" aria-label={t("reader.background")}>
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
        </span>
      </div>
      <label className="reading-setting">
        <span className="reading-setting-name">{t("reading.lineHeight")}</span>
        <input type="range" min={120} max={240} value={Math.round(style.lineHeight * 100)} data-testid="reading-line-height" onChange={(event) => props.onStyle({ lineHeight: Number(event.target.value) / 100 })} />
        <span data-testid="reading-line-height-value" className="reader-size">{style.lineHeight.toFixed(2)}</span>
      </label>
      <label className="reading-setting">
        <span className="reading-setting-name">{t("reading.margin")}</span>
        <input type="range" min={0} max={96} value={style.marginPx} data-testid="reading-margin" onChange={(event) => props.onStyle({ marginPx: Number(event.target.value) })} />
        <span data-testid="reading-margin-value" className="reader-size">{style.marginPx}</span>
      </label>
      <label className="reading-setting">
        <span className="reading-setting-name">{t("reader.paragraph")}</span>
        <input type="range" min={0} max={40} value={style.paragraphSpacingPx ?? 0} data-testid="reading-paragraph" onChange={(event) => props.onStyle({ paragraphSpacingPx: Number(event.target.value) })} />
        <span data-testid="reading-paragraph-value" className="reader-size">{style.paragraphSpacingPx ?? 0}</span>
      </label>
      <label className="reading-setting">
        <span className="reading-setting-name">{t("reading.measure")}</span>
        <input type="range" min={360} max={1200} step={10} value={style.measurePx} data-testid="reading-measure" onChange={(event) => props.onStyle({ measurePx: Number(event.target.value) })} />
        <span data-testid="reading-measure-value" className="reader-size">{style.measurePx}</span>
      </label>
      <div className="reading-setting">
        <span className="reading-setting-name">{t("reader.pageMode")}</span>
        <span className="reader-group" role="group" aria-label={t("reader.pageMode")}>
          <button type="button" className="icon-button" data-testid="reading-mode-single" aria-pressed={!double} aria-label={t("reader.single")} title={t("reader.single")} onClick={() => props.onStyle({ pageMode: "single" })}><Square size={16} /></button>
          <button type="button" className="icon-button" data-testid="reading-mode-double" aria-pressed={double} aria-label={t("reader.double")} title={t("reader.double")} disabled={!props.canDouble} onClick={() => props.onStyle({ pageMode: "double" })}><Columns2 size={16} /></button>
          <button type="button" className="secondary-button reader-ratio" data-testid="reading-ratio" aria-pressed={(style.pageRatio ?? "book") === "book"} disabled={!double} onClick={() => props.onStyle({ pageRatio: (style.pageRatio ?? "book") === "book" ? "free" : "book" })}>{t("reader.ratio")}</button>
        </span>
      </div>
      {props.extra}
    </div>
  );
}
