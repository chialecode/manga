import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export const PAGE_TEXT_LIMIT = 400_000;

/** Tidies text for keeping and for finding offsets in: one space between words, one blank line between paragraphs. */
export function tidy(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t\f\v 　]+/g, " ").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const BLOCKS = /<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|ul|ol|table|figure|figcaption|dd|dt)>/gi;

/** The text of an HTML fragment with a line break where a block ends, so paragraphs survive the removal of the tags. */
function textOfHtml(html: string): string {
  const spaced = html.replace(/<\s*br\s*\/?>/gi, "\n").replace(BLOCKS, "$&\n\n");
  const { document } = parseHTML(`<!doctype html><html><body>${spaced}</body></html>`);
  return document.body?.textContent ?? "";
}

const DROP = "script, style, noscript, template, iframe, object, embed, svg, canvas, link, meta";

/**
 * The readable text of a page and its title. The page is only parsed, never run: no script executes and nothing it points at is loaded.
 * Readability picks the article; a page that is not an article (a list, a table, a short note) falls back to the text of its body.
 */
export function extractPage(source: string, contentType: string, fallbackTitle: string): { title: string; text: string } {
  if (contentType === "text/plain") {
    const text = tidy(source).slice(0, PAGE_TEXT_LIMIT);
    return { title: fallbackTitle, text };
  }
  const first = parseHTML(source).document;
  const pageTitle = tidy(first.querySelector("title")?.textContent ?? "") || tidy(first.querySelector("h1")?.textContent ?? "");
  for (const node of [...first.querySelectorAll(DROP)]) node.remove();
  let article: { title?: string | null; content?: string | null } | null = null;
  try {
    article = new Readability(first as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 120, keepClasses: false }).parse();
  } catch {
    article = null;
  }
  let text = article?.content ? tidy(textOfHtml(article.content)) : "";
  if (text.length < 80) {
    // Readability took the document apart, so the fallback reads a fresh copy.
    const again = parseHTML(source).document;
    for (const node of [...again.querySelectorAll(DROP)]) node.remove();
    const body = tidy(textOfHtml(again.body?.innerHTML ?? ""));
    if (body.length > text.length) text = body;
  }
  return { title: tidy(article?.title ?? "") || pageTitle || fallbackTitle, text: text.slice(0, PAGE_TEXT_LIMIT) };
}
