import { isValidElement, memo, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { math as llmMathSyntax } from "micromark-extension-llm-math";
import { mathFromMarkdown } from "mdast-util-math";
import type { AgentCitation } from "@manga/contracts";
import type { Translator } from "@manga/i18n";
import { CitationBadge, isSafeHref, openExternalLink, type CitationSource } from "./citations.tsx";
import { CodeBlock } from "./code-block.tsx";
import { MathFormula } from "./math-formula.tsx";
import { useThrottleMarkdownRender } from "./use-throttle-markdown.ts";

type T = Translator["t"];

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

const CITE_SCHEME = "manga-cite:";
const CITE_PATTERN = /\[citation:(\d+)\]/gi;

/** Remark plugin wiring `micromark-extension-llm-math` + `mdast-util-math` for `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`. */
export function remarkLlmMath(this: { data: () => Record<string, unknown> }) {
  const data = this.data();
  const micromarkExtensions = (data.micromarkExtensions ??= []) as unknown[];
  const fromMarkdownExtensions = (data.fromMarkdownExtensions ??= []) as unknown[];
  micromarkExtensions.push(llmMathSyntax({ singleDollarTextMath: true }));
  fromMarkdownExtensions.push(mathFromMarkdown());
}

/** Remark plugin that pads ragged GFM table rows so every row matches the widest row in the table. */
export function remarkPadTables() {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      if (node.type === "table" && Array.isArray(node.children)) {
        const maxCols = node.children.reduce((max, row) => Math.max(max, row.children?.length ?? 0), 0);
        for (const row of node.children) {
          if (row.type === "tableRow" && Array.isArray(row.children)) {
            while (row.children.length < maxCols) {
              row.children.push({ type: "tableCell", children: [] });
            }
          }
        }
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) visit(child);
      }
    };
    visit(tree);
  };
}

/** Remark plugin turning inline `[citation:N]` markers in text nodes into `manga-cite:N` links without touching code or math. */
export function remarkCitations() {
  return (tree: MdastNode) => {
    const visit = (node: MdastNode) => {
      if (!Array.isArray(node.children)) return;
      if (node.type === "code" || node.type === "inlineCode" || node.type === "math" || node.type === "inlineMath" || node.type === "link") {
        return;
      }
      const next: MdastNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string" && CITE_PATTERN.test(child.value)) {
          CITE_PATTERN.lastIndex = 0;
          let last = 0;
          let match: RegExpExecArray | null;
          while ((match = CITE_PATTERN.exec(child.value)) !== null) {
            if (match.index > last) {
              next.push({ type: "text", value: child.value.slice(last, match.index) });
            }
            const num = match[1]!;
            next.push({
              type: "link",
              url: `${CITE_SCHEME}${num}`,
              children: [{ type: "text", value: num }],
            });
            last = match.index + match[0].length;
          }
          if (last < child.value.length) {
            next.push({ type: "text", value: child.value.slice(last) });
          }
        } else {
          visit(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    visit(tree);
  };
}

/**
 * Injects `[citation:N]` markers at DeepSeek citation `end` offsets when inline markers are not already present in the text.
 */
export function injectCitationMarkers(text: string, citations?: readonly AgentCitation[]): string {
  if (!text || !citations?.length) return text;
  if (CITE_PATTERN.test(text)) {
    CITE_PATTERN.lastIndex = 0;
    return text;
  }
  const withOffsets = citations
    .map((cite, idx) => ({
      end: cite.end,
      index: cite.index && cite.index > 0 ? cite.index : idx + 1,
    }))
    .filter((entry): entry is { end: number; index: number } => (
      typeof entry.end === "number" && Number.isInteger(entry.end) && entry.end > 0 && entry.end <= text.length
    ))
    .sort((a, b) => b.end - a.end);

  if (withOffsets.length === 0) return text;

  let out = text;
  for (const entry of withOffsets) {
    out = `${out.slice(0, entry.end)}[citation:${entry.index}]${out.slice(entry.end)}`;
  }
  return out;
}

function extractText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return "";
}

const REMARK_PLUGINS = [
  [remarkGfm, { singleTilde: false }],
  remarkLlmMath,
  remarkPadTables,
  remarkCitations,
] as const;

const SAFE_LOCAL_IMAGE_RE = /^(data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,|blob:|manga-media:)/i;

function sanitizeUrl(url: string, key?: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith(CITE_SCHEME)) return trimmed;
  if (key === "src" && SAFE_LOCAL_IMAGE_RE.test(trimmed)) return trimmed;
  return isSafeHref(trimmed) ? trimmed : "";
}

export type ChatMarkdownProps = {
  t: T;
  text: string;
  streaming?: boolean;
  citations?: readonly AgentCitation[];
  sources?: readonly CitationSource[];
  compact?: boolean;
};

/**
 * LLM-friendly Markdown renderer for assistant replies and thinking notes.
 * Supports GFM tables (horizontal scroll + ragged-row padding), safe link sanitization, CJK-safe tilde handling,
 * lazy PrismJS code blocks, lazy Mermaid diagrams, lazy KaTeX math (`$...$`, `$$...$$`, `\(...\)`, `\[...\]`),
 * inline `[citation:N]` badges, and adaptive streaming throttling.
 */
export const ChatMarkdown = memo(function ChatMarkdown(props: ChatMarkdownProps) {
  const { t, text, streaming = false, citations, sources, compact = false } = props;
  const enriched = useMemo(() => (citations?.length ? injectCitationMarkers(text, citations) : text), [text, citations]);
  const throttled = useThrottleMarkdownRender(enriched, streaming);

  const sourceMap = useMemo(() => {
    const map = new Map<number, CitationSource>();
    for (const source of sources ?? []) map.set(source.index, source);
    return map;
  }, [sources]);

  const components = useMemo<Components>(() => ({
    a: ({ href, children, ...rest }) => {
      if (href?.startsWith(CITE_SCHEME)) {
        const index = Number.parseInt(href.slice(CITE_SCHEME.length), 10);
        if (Number.isFinite(index) && index > 0) {
          return <CitationBadge t={t} index={index} source={sourceMap.get(index)} />;
        }
      }
      if (!href || !isSafeHref(href)) {
        return <span>{children}</span>;
      }
      return (
        <a
          {...rest}
          href={href}
          rel="noopener noreferrer"
          onClick={(event) => {
            if (/^https?:\/\//i.test(href)) {
              event.preventDefault();
              openExternalLink(href);
            }
          }}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      const url = (src ?? "").trim();
      if (SAFE_LOCAL_IMAGE_RE.test(url)) {
        return <img src={url} alt={alt ?? ""} className="chat-markdown-img" loading="lazy" referrerPolicy="no-referrer" />;
      }
      const label = alt?.trim() || url;
      if (url && /^https?:\/\//i.test(url)) {
        return (
          <a
            href={url}
            rel="noopener noreferrer"
            data-testid="chat-markdown-external-img"
            onClick={(event) => {
              event.preventDefault();
              openExternalLink(url);
            }}
          >
            {label}
          </a>
        );
      }
      return label ? <span>{label}</span> : null;
    },
    pre: ({ children }) => {
      const first = Array.isArray(children) ? children[0] : children;
      if (isValidElement<{ className?: string; children?: ReactNode }>(first)) {
        const cls = first.props.className ?? "";
        const rawCode = extractText(first.props.children).replace(/\n$/, "");
        if (cls.includes("math-display")) {
          return <MathFormula value={rawCode} display streaming={streaming} />;
        }
        const match = /language-([^\s]+)/.exec(cls);
        return <CodeBlock t={t} code={rawCode} language={match?.[1]} streaming={streaming} />;
      }
      return <pre className="chat-codeblock-pre">{children}</pre>;
    },
    code: ({ className, children, ...rest }) => {
      const cls = className ?? "";
      if (cls.includes("math-inline")) {
        return <MathFormula value={extractText(children)} display={false} streaming={streaming} />;
      }
      return <code {...rest} className={`chat-inline-code ${cls}`.trim()}>{children}</code>;
    },
    table: ({ children, ...rest }) => (
      <div className="chat-table-wrap">
        <table {...rest}>{children}</table>
      </div>
    ),
  }), [t, sourceMap, streaming]);

  return (
    <div className={`bubble-text bubble-markdown ${compact ? "bubble-markdown-compact" : ""}`}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS as never}
        urlTransform={sanitizeUrl}
        components={components}
      >
        {throttled}
      </Markdown>
    </div>
  );
});
