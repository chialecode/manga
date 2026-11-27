import { memo, useEffect, useId, useRef, useState } from "react";
import { Check, Code2, Copy, GitBranch, WrapText } from "lucide-react";
import type { Translator } from "@manga/i18n";

type T = Translator["t"];

type PrismLike = {
  languages: Record<string, unknown>;
  highlight: (text: string, grammar: unknown, language: string) => string;
};

const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "markup",
  xml: "markup",
  svg: "markup",
  rs: "rust",
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
};

const DISPLAY_LABEL: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  tsx: "TSX",
  jsx: "JSX",
  python: "Python",
  json: "JSON",
  bash: "Bash",
  css: "CSS",
  markup: "HTML",
  sql: "SQL",
  rust: "Rust",
  go: "Go",
  yaml: "YAML",
  markdown: "Markdown",
  c: "C",
  cpp: "C++",
  java: "Java",
  diff: "Diff",
  mermaid: "Mermaid",
};

const GRAMMAR_DEPS: Record<string, string[]> = {
  javascript: ["clike"],
  typescript: ["clike", "javascript"],
  jsx: ["markup", "clike", "javascript"],
  tsx: ["markup", "clike", "javascript", "typescript", "jsx"],
  c: ["clike"],
  cpp: ["clike", "c"],
  java: ["clike"],
};

const GRAMMAR_LOADERS: Record<string, () => Promise<unknown>> = {
  clike: () => import("prismjs/components/prism-clike"),
  markup: () => import("prismjs/components/prism-markup"),
  javascript: () => import("prismjs/components/prism-javascript"),
  typescript: () => import("prismjs/components/prism-typescript"),
  jsx: () => import("prismjs/components/prism-jsx"),
  tsx: () => import("prismjs/components/prism-tsx"),
  python: () => import("prismjs/components/prism-python"),
  json: () => import("prismjs/components/prism-json"),
  bash: () => import("prismjs/components/prism-bash"),
  css: () => import("prismjs/components/prism-css"),
  sql: () => import("prismjs/components/prism-sql"),
  rust: () => import("prismjs/components/prism-rust"),
  go: () => import("prismjs/components/prism-go"),
  yaml: () => import("prismjs/components/prism-yaml"),
  markdown: () => import("prismjs/components/prism-markdown"),
  c: () => import("prismjs/components/prism-c"),
  cpp: () => import("prismjs/components/prism-cpp"),
  java: () => import("prismjs/components/prism-java"),
  diff: () => import("prismjs/components/prism-diff"),
};

let prismCore: PrismLike | null = null;
let prismLoader: Promise<PrismLike> | null = null;
const loadedGrammars = new Map<string, Promise<void>>();

function normalizeLang(raw?: string): string {
  const clean = (raw ?? "").trim().toLowerCase().replace(/^language-/, "");
  if (!clean) return "";
  return LANG_ALIASES[clean] ?? clean;
}

async function ensurePrism(): Promise<PrismLike> {
  if (prismCore) return prismCore;
  if (!prismLoader) {
    prismLoader = import("prismjs").then((mod) => {
      const p = (mod.default ?? mod) as unknown as PrismLike;
      // Expose globally for prism component side-effect modules.
      (globalThis as unknown as { Prism?: PrismLike }).Prism = p;
      prismCore = p;
      return p;
    });
  }
  return prismLoader;
}

async function ensureGrammar(lang: string): Promise<PrismLike | null> {
  if (!lang || !GRAMMAR_LOADERS[lang]) return null;
  const prism = await ensurePrism();
  if (prism.languages[lang]) return prism;
  const deps = GRAMMAR_DEPS[lang] ?? [];
  for (const dep of deps) {
    if (!prism.languages[dep]) await ensureGrammar(dep);
  }
  let loading = loadedGrammars.get(lang);
  if (!loading) {
    loading = GRAMMAR_LOADERS[lang]!().then(() => undefined).catch(() => undefined);
    loadedGrammars.set(lang, loading);
  }
  await loading;
  return prism.languages[lang] ? prism : null;
}

// ---------------------------------------------------------------------------
// Lazy serialized Mermaid renderer with strict sanitization
// ---------------------------------------------------------------------------

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidLoader: Promise<MermaidApi> | null = null;
let mermaidThemeApplied: string | null = null;
let mermaidQueue: Promise<unknown> = Promise.resolve();

function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
}

function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState<boolean>(isDarkTheme);
  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const sync = () => setDark(root.getAttribute("data-theme") === "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then((mod) => (mod.default ?? mod) as unknown as MermaidApi);
  }
  return mermaidLoader;
}

/** Strips `<img` and `<image` tags from generated SVG as defense-in-depth against external resource fetches. */
export function sanitizeMermaidSvg(svg: string): string {
  return svg
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "")
    .replace(/<image\b[^>]*\/?>/gi, "")
    .replace(/<img\b[^>]*\/?>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function enqueueMermaidRender(id: string, code: string, dark: boolean): Promise<string> {
  const job = mermaidQueue.then(async () => {
    const api = await loadMermaid();
    const theme = dark ? "dark" : "default";
    if (mermaidThemeApplied !== theme) {
      api.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme,
        suppressErrorRendering: true,
      });
      mermaidThemeApplied = theme;
    }
    const result = await api.render(`${id}-${dark ? "d" : "l"}`, code);
    return sanitizeMermaidSvg(result.svg);
  });
  mermaidQueue = job.catch(() => undefined);
  return job;
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export type CodeBlockProps = {
  t: T;
  code: string;
  language?: string;
  streaming?: boolean;
};

/**
 * Syntax-highlighted code block with rounded header bar, language badge, line-wrap toggle, and copy feedback.
 * Mermaid blocks render lazily as sanitized SVG diagrams with a Diagram/Code toggle and streaming last-valid retention.
 */
export const CodeBlock = memo(function CodeBlock(props: CodeBlockProps) {
  const { t, code, streaming = false } = props;
  const lang = normalizeLang(props.language);
  const isMermaid = lang === "mermaid";
  const [wrapped, setWrapped] = useState(false);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"diagram" | "code">("diagram");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [diagramFailed, setDiagramFailed] = useState(false);
  const lastValidSvg = useRef<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const rawId = useId();
  const mermaidId = `manga-mmd-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const darkTheme = useIsDarkTheme();

  useEffect(() => () => { window.clearTimeout(copyTimer.current); }, []);

  // Lazy PrismJS syntax highlighting.
  useEffect(() => {
    if (isMermaid && view === "diagram") return;
    if (!lang || !GRAMMAR_LOADERS[lang]) {
      setHighlighted(null);
      return;
    }
    if (prismCore?.languages[lang]) {
      try {
        setHighlighted(prismCore.highlight(code, prismCore.languages[lang], lang));
      } catch {
        setHighlighted(null);
      }
      return;
    }
    let active = true;
    void ensureGrammar(lang).then((prism) => {
      if (!active || !prism || !prism.languages[lang]) return;
      try {
        setHighlighted(prism.highlight(code, prism.languages[lang], lang));
      } catch {
        setHighlighted(null);
      }
    });
    return () => { active = false; };
  }, [code, lang, isMermaid, view]);

  // Lazy serialized Mermaid rendering with last-valid retention during streaming and live dark/light theme sync.
  useEffect(() => {
    if (!isMermaid || view !== "diagram") return;
    const source = code.trim();
    if (!source) return;
    let active = true;
    void enqueueMermaidRender(mermaidId, source, darkTheme).then((rendered) => {
      if (!active) return;
      lastValidSvg.current = rendered;
      setSvg(rendered);
      setDiagramFailed(false);
    }).catch(() => {
      if (!active) return;
      if (streaming && lastValidSvg.current) {
        setSvg(lastValidSvg.current);
        setDiagramFailed(false);
      } else if (!streaming) {
        setDiagramFailed(true);
      }
    });
    return () => { active = false; };
  }, [code, isMermaid, view, streaming, mermaidId, darkTheme]);

  const onCopy = () => {
    void copyText(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const badge = DISPLAY_LABEL[lang] ?? (lang ? lang.toUpperCase() : t("chat.code.plain"));

  return (
    <div className="chat-codeblock" data-testid="chat-codeblock" data-language={lang || "plain"} data-wrapped={wrapped ? "true" : "false"}>
      <div className="chat-codeblock-head">
        <span className="chat-codeblock-lang">{badge}</span>
        <div className="chat-codeblock-actions">
          {isMermaid ? (
            <div className="chat-codeblock-toggle" role="group" aria-label={badge}>
              <button
                type="button"
                className="chat-codeblock-btn"
                data-testid="chat-mermaid-diagram"
                aria-pressed={view === "diagram"}
                onClick={() => setView("diagram")}
              >
                <GitBranch size={13} aria-hidden="true" />
                <span>{t("chat.code.diagram")}</span>
              </button>
              <button
                type="button"
                className="chat-codeblock-btn"
                data-testid="chat-mermaid-code"
                aria-pressed={view === "code"}
                onClick={() => setView("code")}
              >
                <Code2 size={13} aria-hidden="true" />
                <span>{t("chat.code.source")}</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="chat-codeblock-btn"
              data-testid="chat-code-wrap"
              aria-pressed={wrapped}
              title={wrapped ? t("chat.code.unwrap") : t("chat.code.wrap")}
              onClick={() => setWrapped((value) => !value)}
            >
              <WrapText size={13} aria-hidden="true" />
              <span>{wrapped ? t("chat.code.unwrap") : t("chat.code.wrap")}</span>
            </button>
          )}
          <button
            type="button"
            className="chat-codeblock-btn"
            data-testid="chat-code-copy"
            data-copied={copied ? "true" : "false"}
            onClick={onCopy}
          >
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            <span>{copied ? t("chat.code.copied") : t("chat.code.copy")}</span>
          </button>
        </div>
      </div>

      {isMermaid && view === "diagram" ? (
        <div className="chat-mermaid" data-testid="chat-mermaid">
          {svg ? (
            <div
              className="chat-mermaid-svg"
              data-testid="chat-mermaid-svg"
              // Sanitized Mermaid SVG (`securityLevel: "strict"`, no `<img>`/`<image>`/`<script>`).
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="chat-mermaid-fallback">
              {diagramFailed ? <p className="detail-muted chat-mermaid-error">{t("chat.code.diagramError")}</p> : null}
              <pre className="chat-codeblock-pre"><code>{code}</code></pre>
            </div>
          )}
        </div>
      ) : (
        <pre className={`chat-codeblock-pre ${wrapped ? "is-wrapped" : ""}`}>
          {highlighted !== null ? (
            <code
              className={lang ? `language-${lang}` : undefined}
              // Output from local PrismJS tokenizer over source code.
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          ) : (
            <code className={lang ? `language-${lang}` : undefined}>{code}</code>
          )}
        </pre>
      )}
    </div>
  );
});
