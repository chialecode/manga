import { memo, useEffect, useRef, useState } from "react";

type KatexLike = {
  renderToString: (tex: string, options: { displayMode: boolean; throwOnError: boolean; strict: boolean | string; trust: boolean }) => string;
};

let katexInstance: KatexLike | null = null;
let katexLoader: Promise<KatexLike> | null = null;

async function loadKatex(): Promise<KatexLike> {
  if (katexInstance) return katexInstance;
  if (!katexLoader) {
    katexLoader = (async () => {
      const mod = await import("katex");
      const katex = (mod.default ?? mod) as unknown as KatexLike;
      // Load CSS and mhchem extension lazily on first formula render.
      await Promise.all([
        import("katex/dist/katex.min.css").catch(() => undefined),
        import("katex/contrib/mhchem").catch(() => undefined),
      ]);
      katexInstance = katex;
      return katex;
    })();
  }
  return katexLoader;
}

function tryRender(katex: KatexLike, value: string, display: boolean): string | null {
  try {
    return katex.renderToString(value, {
      displayMode: display,
      throwOnError: true,
      strict: "ignore",
      trust: false,
    });
  } catch {
    return null;
  }
}

export type MathFormulaProps = {
  value: string;
  display?: boolean;
  streaming?: boolean;
};

/**
 * Lazy-loaded KaTeX formula renderer (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`).
 * Retains the last valid rendered HTML during streaming so incomplete TeX expressions never flash raw errors.
 */
export const MathFormula = memo(function MathFormula(props: MathFormulaProps) {
  const { value, display = false, streaming = false } = props;
  const lastValidHtml = useRef<string | null>(null);
  const [loaded, setLoaded] = useState<KatexLike | null>(() => katexInstance);

  useEffect(() => {
    if (loaded) return;
    let active = true;
    void loadKatex().then((mod) => {
      if (active) setLoaded(mod);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [loaded]);

  let html: string | null = null;
  if (loaded) {
    const rendered = tryRender(loaded, value, display);
    if (rendered !== null) {
      lastValidHtml.current = rendered;
      html = rendered;
    } else if (streaming && lastValidHtml.current !== null) {
      html = lastValidHtml.current;
    } else {
      try {
        html = loaded.renderToString(value, {
          displayMode: display,
          throwOnError: false,
          strict: "ignore",
          trust: false,
        });
      } catch {
        html = null;
      }
    }
  }

  if (html !== null) {
    if (display) {
      return (
        <div
          className="chat-math-block"
          data-testid="chat-math-block"
          // Rendered locally by KaTeX with `trust: false` (no raw HTML injection).
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    return (
      <span
        className="chat-math-inline"
        data-testid="chat-math-inline"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  if (display) {
    return <pre className="chat-math-fallback" data-testid="chat-math-block"><code>{value}</code></pre>;
  }
  return <code className="chat-math-fallback" data-testid="chat-math-inline">{value}</code>;
});
