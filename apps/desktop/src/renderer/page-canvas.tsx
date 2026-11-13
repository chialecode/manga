import type { PageRender, ReadingAsset } from "./reading-helpers.ts";

const PAGE_FONTS: Record<string, string> = {
  sans: '"Microsoft YaHei", system-ui, sans-serif',
  serif: 'SimSun, "Noto Serif CJK SC", serif',
  mono: 'Consolas, "Microsoft YaHei", monospace',
};

export function ReadingImage(props: { asset?: ReadingAsset; src?: string; measure: number; offset?: number; pending: string; failed: string }) {
  if (!props.asset) return <span className="text-sm text-[var(--color-subtle)]" data-testid="reading-image-failed">{props.failed}</span>;
  if (!props.asset.mediaType.startsWith("image/")) {
    return <span className="text-sm text-[var(--color-subtle)]" data-testid={`reading-image-failed-${props.asset.id}`}>{props.failed}</span>;
  }
  if (!props.src) return <span className="text-sm text-[var(--color-subtle)]" data-testid={`reading-image-pending-${props.asset.id}`}>{props.pending.replace("{count}", "1")}</span>;
  return <img src={props.src} alt="" style={{ maxWidth: props.measure }} data-testid={`reading-image-${props.asset.id}`} data-offset={props.offset ?? undefined} />;
}

/** Render the stored positional model of one page: an SVG page box with positioned runs, boxes and images. */
export function PageCanvas(props: { render: PageRender; assets: Record<string, string>; truncatedLabel: string }) {
  const { w, h, items } = props.render;
  return (
    <div className="relative mx-auto mb-2" data-testid="reading-page-render" data-truncated={props.render.truncated ? "1" : undefined} style={{ maxWidth: "100%", background: "#ffffff", border: "1px solid var(--color-border)" }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ display: "block", width: "100%", height: "auto" }} role="img" aria-label="page">
        {items.map((item, index) => {
          if (item.k === "r") {
            if (item.c === "none") return null;
            return <rect key={index} x={item.x} y={h - item.y - item.h} width={item.w} height={item.h} fill={item.c} />;
          }
          if (item.k === "e") {
            if (item.c === "none") return null;
            return <ellipse key={index} cx={item.x + item.w / 2} cy={h - item.y - item.h / 2} rx={item.w / 2} ry={item.h / 2} fill={item.c} />;
          }
          if (item.k === "l") {
            const points = item.p.map((value, index2) => index2 % 2 === 0 ? value : h - value).join(",");
            return <polyline key={index} points={points} fill="none" stroke={item.c} strokeWidth={Math.max(item.w, 0.5)} />;
          }
          if (item.k === "i") {
            const url = item.a ? props.assets[item.a] : undefined;
            if (!url) return null;
            return <image key={index} href={url} x={item.x} y={h - item.y - item.h} width={item.w} height={item.h} preserveAspectRatio="none" />;
          }
          const perGlyph = item.gx && item.gx.length === item.t.length ? item.gx : undefined;
          return (
            <text
              key={index}
              // The model supplies every glyph's origin, so joined and split Tj sequences of the same
              // content draw identically regardless of the browser font's own metrics. The run's total
              // advance (from the same model) still scales the glyph inks to the laid-out width, which
              // keeps a horizontally squeezed run from spilling over the next run's origin.
              x={perGlyph ? perGlyph.join(" ") : item.x}
              y={h - item.y}
              fontSize={item.s}
              fontFamily={PAGE_FONTS[item.f] ?? PAGE_FONTS.sans}
              fill={item.c ?? "#111111"}
              textLength={item.w && item.w > 0 ? item.w : undefined}
              lengthAdjust={item.w && item.w > 0 ? "spacingAndGlyphs" : undefined}
              data-cp={item.o ?? undefined}
              data-testid={`page-run-${index}`}
            >{item.t}</text>
          );
        })}
      </svg>
      {props.render.truncated ? <p className="text-xs text-[var(--color-subtle)] p-1" data-testid="reading-page-truncated">{props.truncatedLabel}</p> : null}
    </div>
  );
}
