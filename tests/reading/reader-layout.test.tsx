/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DEFAULT_SHELL_PREFERENCE, ReadingPreferenceSchema, ReadingStylePatchSchema, ShellPreferenceSchema } from "@manga/contracts/reading";
import { layoutParagraphs, layoutText } from "../../apps/desktop/src/renderer/reader/paragraphs.ts";
import { fontStack } from "../../apps/desktop/src/renderer/reader/fonts.ts";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
import { readingLabels } from "../../apps/desktop/src/renderer/lib/labels.ts";

const i18n = createTranslator("zh-CN");

afterEach(() => cleanup());

describe("M2 reader paragraphs", () => {
  it("keeps the rendered text identical to the stored text, with the separators hidden in place", () => {
    const text = "甲乙\n\n丙丁戊\n己";
    const pieces = layoutParagraphs(text, 10, null, []);
    expect(layoutText(pieces)).toBe(text);
    expect(pieces.map((piece) => piece.kind)).toEqual(["paragraph", "separator", "paragraph", "separator", "paragraph"]);
    expect(pieces[0]).toMatchObject({ kind: "paragraph", start: 10 });
    expect(pieces[2]).toMatchObject({ kind: "paragraph", start: 14 });
  });

  it("cuts a highlight that crosses paragraphs into one mark per paragraph", () => {
    const pieces = layoutParagraphs("甲乙丙\n丁戊己", 0, { start: 1, end: 5 }, []);
    const marked = pieces.flatMap((piece) => piece.kind === "paragraph" ? piece.parts.filter((part) => part.kind === "text" && part.marked) : []);
    expect(marked.map((part) => (part as { text: string }).text)).toEqual(["乙丙", "丁"]);
    expect(layoutText(pieces)).toBe("甲乙丙\n丁戊己");
  });

  it("places illustrations at their offsets, inside a paragraph or between paragraphs, without changing the text", () => {
    const pieces = layoutParagraphs("甲乙丙\n丁戊", 5, null, [{ assetId: "a", offset: 6 }, { assetId: "b", offset: 9 }]);
    expect(layoutText(pieces)).toBe("甲乙丙\n丁戊");
    const first = pieces[0] as { parts: Array<{ kind: string }> };
    expect(first.parts.map((part) => part.kind)).toEqual(["text", "image", "text"]);
    expect(pieces.some((piece) => piece.kind === "image" || (piece.kind === "paragraph" && piece.parts.some((part) => part.kind === "image" && (part as { assetId: string }).assetId === "b")))).toBe(true);
  });

  it("handles astral characters by code point", () => {
    const pieces = layoutParagraphs("😀甲\n乙", 0, { start: 1, end: 2 }, []);
    expect(layoutText(pieces)).toBe("😀甲\n乙");
    const first = pieces[0] as { parts: Array<{ text?: string; marked?: boolean }> };
    expect(first.parts.find((part) => part.marked)?.text).toBe("甲");
  });
});

describe("M2 reader preferences", () => {
  it("accepts a value saved before the new fields existed and fills the defaults", () => {
    const old = { measurePx: 680, fontSizePx: 18, fontFamily: "serif", lineHeight: 1.7, marginPx: 24, theme: "green" };
    expect(ReadingPreferenceSchema.parse(old)).toMatchObject({ ...old, paragraphSpacingPx: 0, pageMode: "single", pageRatio: "book" });
    const stored = { ...DEFAULT_SHELL_PREFERENCE, reading: old };
    expect(ShellPreferenceSchema.parse(stored).reading.pageMode).toBe("single");
  });

  it("rejects a font family name that could break out of a CSS font stack", () => {
    for (const bad of ['Evil"; color: red', "a;b", "x{y}", "\u0000", "a\\b", ""]) expect(ReadingStylePatchSchema.safeParse({ fontFamily: bad }).success).toBe(false);
    expect(ReadingStylePatchSchema.safeParse({ fontFamily: "思源宋体 CN" }).success).toBe(true);
    expect(ReadingStylePatchSchema.safeParse({ theme: "teal", pageMode: "double", pageRatio: "free", paragraphSpacingPx: 12 }).success).toBe(true);
    expect(ReadingStylePatchSchema.safeParse({ theme: "purple" }).success).toBe(false);
  });

  it("quotes an installed family in the font stack and keeps the presets", () => {
    expect(fontStack("serif")).toContain("SimSun");
    expect(fontStack("思源宋体 CN")).toBe('"思源宋体 CN", "Microsoft YaHei", system-ui, sans-serif');
    expect(fontStack(undefined)).toContain("Microsoft YaHei");
  });
});

function doc(text: string): ReadingDocument {
  return {
    resourceId: "res_1", revisionId: "rev_1", title: "合成书", format: "txt", warnings: [],
    toc: [{ label: "正文", partId: "body" }],
    parts: [{ id: "body", title: "第一章", kind: "text", length: 2000, textLayer: true }],
    slice: { partId: "body", text, start: 0, end: [...text].length, kind: "text", textLayer: true, images: [] },
    source: { available: true },
  };
}

const baseStyle = { measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, theme: "white" };

function pane(style: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return render(
    <ReadingPane
      document={doc("甲乙丙\n丁戊己")} style={{ ...baseStyle, ...style }} labels={readingLabels(i18n)} t={i18n.t}
      labelsExtra={{ backToNote: "", sourceResolved: "", sourceNeedsReview: "", sourceMissing: "", sourceRepair: "", sourceCard: "" }}
      hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
      onSearch={() => {}} onJump={() => {}} onProgress={() => {}} onNote={() => {}} onMore={() => {}} onPart={() => {}}
      onStyle={() => {}} onBookmark={() => {}} onRemoveBookmark={() => {}} onOpenBookmark={() => {}} onBackToNote={() => {}} onRepair={() => {}}
      {...extra}
    />,
  );
}

describe("M2 novel reader", () => {
  it("shows the book name, the medium, the chapter and a way back", () => {
    const back = vi.fn();
    pane({}, { onBack: back });
    expect(screen.getByTestId("reading-title").textContent).toBe("合成书");
    expect(screen.getByTestId("reading-page").textContent).toContain("第一章");
    fireEvent.click(screen.getByTestId("reading-back"));
    expect(back).toHaveBeenCalled();
  });

  it("lays text out as paragraphs when a paragraph spacing is set, without changing the body text", () => {
    pane({ paragraphSpacingPx: 14 });
    const body = screen.getByTestId("reading-body");
    expect(body.textContent).toBe("甲乙丙\n丁戊己");
    expect(body.querySelectorAll("p.reader-paragraph")).toHaveLength(2);
  });

  it("offers single and double pages, the five backgrounds and a size step that stays within its range", () => {
    const styled = vi.fn();
    pane({ fontSizePx: 32 }, { onStyle: styled });
    expect(screen.getByTestId("reading-font-larger")).toHaveProperty("disabled", true);
    for (const theme of ["white", "paper", "green", "teal", "night"]) expect(screen.getByTestId(`reading-theme-${theme}`)).toBeTruthy();
    expect(screen.queryByTestId("reading-spread")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-mode-double"));
    expect(styled).toHaveBeenCalledWith({ pageMode: "double" });
  });

  it("renders a double page with the title in the head and the position in the foot, and still exposes the body for selection", () => {
    pane({ pageMode: "double" });
    expect(screen.getByTestId("reading-spread")).toBeTruthy();
    expect(screen.getByTestId("reading-body").getAttribute("data-layout")).toBe("double");
    expect(screen.getByTestId("reading-body").textContent).toBe("甲乙丙\n丁戊己");
    expect(screen.getByTestId("reading-spread-position").textContent).toContain("1");
    // The page background belongs to the reading column only.
    expect(screen.getByTestId("reading-spread").getAttribute("style")).toContain("background");
  });

  it("changes pages with the arrow keys in a double page, and leaves the keys to a text field", () => {
    const more = vi.fn();
    pane({ pageMode: "double" }, { onMore: more });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(more).toHaveBeenCalled();
    more.mockClear();
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(more).not.toHaveBeenCalled();
    input.remove();
  });

  it("keeps the search, bookmark and contents panels closed until asked", () => {
    pane({});
    expect(screen.queryByTestId("reading-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-panel-toc"));
    expect(screen.getByTestId("toc-body")).toBeTruthy();
  });
});
