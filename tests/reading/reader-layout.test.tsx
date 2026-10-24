/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DEFAULT_SHELL_PREFERENCE, ReadingPreferenceSchema, ReadingStylePatchSchema, ShellPreferenceSchema } from "@manga/contracts/reading";
import { layoutParagraphs, layoutText } from "../../apps/desktop/src/renderer/reader/paragraphs.ts";
import { fontStack } from "../../apps/desktop/src/renderer/reader/fonts.ts";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
import { readingLabels } from "../../apps/desktop/src/renderer/lib/labels.ts";
import { AUTO_HIDE_MS, inEdge } from "../../apps/desktop/src/renderer/reader/use-auto-hide.ts";

const i18n = createTranslator("zh-CN");

afterEach(() => { cleanup(); vi.useRealTimers(); });

// jsdom has no PointerEvent; the reader reads where the pointer is from it.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventForTests extends MouseEvent {
    readonly pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) { super(type, init); this.pointerType = init.pointerType ?? "mouse"; }
  }
  Object.assign(window, { PointerEvent: PointerEventForTests });
}

describe("reader paragraphs", () => {
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

describe("reader preferences", () => {
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
      labelsExtra={{ sourceNeedsReview: "", sourceMissing: "", sourceRepair: "" }}
      hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
      onSearch={() => {}} onJump={() => {}} onProgress={() => {}} onNote={() => {}} onMore={() => {}} onPart={() => {}}
      onStyle={() => {}} onBookmark={() => {}} onRemoveBookmark={() => {}} onOpenBookmark={() => {}} onBackToNote={() => {}} onRepair={() => {}}
      {...extra}
    />,
  );
}

describe("novel reader", () => {
  it("has no bar at the top: the book name and the way back are the title bar's, and the chapter is in the bottom bar (AT-83)", () => {
    const { container } = pane({});
    expect(container.querySelector(".reader-top")).toBeNull();
    expect(container.querySelector(".reader-chrome")).toBeNull();
    for (const gone of ["reading-title", "reading-back", "reading-chrome"]) expect(screen.queryByTestId(gone), gone).toBeNull();
    expect(screen.getByTestId("reading-footer").contains(screen.getByTestId("reading-chapter"))).toBe(true);
    expect(screen.getByTestId("reading-chapter").textContent).toBe("第一章");
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
    fireEvent.click(screen.getByTestId("reading-settings"));
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

  it("turns the pages of a double page with buttons that are about pages, not parts; a single page has none (AT-83)", () => {
    const more = vi.fn();
    pane({}, { onMore: more });
    expect(screen.queryByTestId("reading-spread-prev")).toBeNull();
    expect(screen.queryByTestId("reading-spread-next")).toBeNull();
    cleanup();
    pane({ pageMode: "double" }, { onMore: more });
    const foot = screen.getByTestId("reading-footer");
    expect(foot.contains(screen.getByTestId("reading-spread-next"))).toBe(true);
    expect(screen.getByTestId("reading-spread-prev")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("reading-spread-next"));
    expect(more).toHaveBeenCalled();
    for (const gone of ["reading-prev", "reading-next"]) expect(screen.queryByTestId(gone), gone).toBeNull();
  });

  it("keeps the search, bookmark and contents panels closed until asked", () => {
    pane({});
    expect(screen.queryByTestId("reading-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-panel-toc"));
    expect(screen.getByTestId("toc-body")).toBeTruthy();
    // The panel is part of the bottom bar and opens above its buttons.
    expect(screen.getByTestId("reading-footer").contains(screen.getByTestId("reading-panel"))).toBe(true);
    expect(screen.getByTestId("reading-panel").getAttribute("data-placement")).toBe("above");
  });
});

describe("novel reader as a regular reader (A-63)", () => {
  const style = { measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, theme: "white", paragraphSpacingPx: 6, pageMode: "single" as const, pageRatio: "book" as const };

  it("keeps every reading setting in one panel that is closed until asked, and applies a change at once", () => {
    const styled = vi.fn();
    pane({}, { onStyle: styled });
    expect(screen.queryByTestId("reading-settings-panel")).toBeNull();
    expect(screen.queryByTestId("reading-style")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-settings"));
    const panel = screen.getByTestId("reading-settings-panel");
    // Font, size, line height, margins, paragraph spacing, line width, background and page mode.
    for (const id of ["reading-font-family", "reading-font-larger", "reading-line-height", "reading-margin", "reading-paragraph", "reading-measure", "reading-theme-paper", "reading-mode-double"]) {
      expect(panel.contains(screen.getByTestId(id))).toBe(true);
    }
    fireEvent.change(screen.getByTestId("reading-font-family"), { target: { value: "serif" } });
    expect(styled).toHaveBeenLastCalledWith({ fontFamily: "serif" });
    fireEvent.click(screen.getByTestId("reading-font-larger"));
    expect(styled).toHaveBeenLastCalledWith({ fontSizePx: 19 });
    fireEvent.change(screen.getByTestId("reading-line-height"), { target: { value: "200" } });
    expect(styled).toHaveBeenLastCalledWith({ lineHeight: 2 });
    fireEvent.change(screen.getByTestId("reading-margin"), { target: { value: "40" } });
    expect(styled).toHaveBeenLastCalledWith({ marginPx: 40 });
    fireEvent.change(screen.getByTestId("reading-paragraph"), { target: { value: "12" } });
    expect(styled).toHaveBeenLastCalledWith({ paragraphSpacingPx: 12 });
    fireEvent.change(screen.getByTestId("reading-measure"), { target: { value: "900" } });
    expect(styled).toHaveBeenLastCalledWith({ measurePx: 900 });
    fireEvent.click(screen.getByTestId("reading-theme-paper"));
    expect(styled).toHaveBeenLastCalledWith({ theme: "paper" });
    fireEvent.click(screen.getByTestId("reading-mode-double"));
    expect(styled).toHaveBeenLastCalledWith({ pageMode: "double" });
  });

  it("closes the settings with Esc or a click outside, and not with a click inside", () => {
    pane({});
    fireEvent.click(screen.getByTestId("reading-settings"));
    fireEvent.pointerDown(screen.getByTestId("reading-measure"));
    expect(screen.getByTestId("reading-settings-panel")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("reading-settings-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-settings"));
    fireEvent.pointerDown(screen.getByTestId("reading-body"));
    expect(screen.queryByTestId("reading-settings-panel")).toBeNull();
  });

  it("paints the chosen background over the whole reading area and not only behind the column", () => {
    pane({ theme: "night" });
    expect(screen.getByTestId("reading-scroll").getAttribute("style")).toContain("background");
    expect(screen.getByTestId("reading-page").getAttribute("data-theme")).toBe("night");
  });

  it("shows no debug facts in the reading area: where the position came from, the read ranges, the part's source file", () => {
    render(
      <ReadingPane
        document={{
          ...doc("甲乙丙丁戊己"),
          parts: [{ id: "body", title: "第一章", kind: "text", length: 2000, textLayer: true, sourceHref: "OEBPS/ch1.xhtml" }],
          progress: { locator: null, consumed: [{ partId: "body", start: 0, end: 3 }], completion: "reading", restoredFrom: "progress", restoredRange: { start: 4, end: 6 } },
          readRanges: [{ partId: "body", start: 0, end: 3 }],
        }}
        style={{ ...baseStyle }} labels={readingLabels(i18n)} t={i18n.t} labelsExtra={{ sourceNeedsReview: "", sourceMissing: "", sourceRepair: "" }}
        hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
        onSearch={() => {}} onJump={() => {}} onProgress={() => {}} onMore={() => {}} onPart={() => {}} onSelect={() => {}}
        onStyle={() => {}} onBookmark={() => {}} onRemoveBookmark={() => {}} onOpenBookmark={() => {}} onBackToNote={() => {}} onRepair={() => {}}
      />,
    );
    expect(screen.queryByTestId("reading-restore-status")).toBeNull();
    expect(screen.queryByTestId("reading-part-source")).toBeNull();
    const text = screen.getByTestId("reading-page").textContent ?? "";
    for (const debug of [i18n.t("reading.restored"), i18n.t("reading.restoredStart"), "已读范围", "ch1.xhtml", "源文件"]) expect(text).not.toContain(debug);
    expect(screen.getByTestId("reading-body").textContent).toBe("甲乙丙丁戊己");
  });

  it("uses the shared source banner of the comic and video readers for a note's source", () => {
    const back = vi.fn();
    pane({}, { sourceCard: { status: "needs_review", title: "合成书", quote: "丙丁" }, onBackToNote: back });
    const banner = screen.getByTestId("reading-source-card");
    expect(banner.className).toContain("reader-source");
    expect(banner.getAttribute("data-source-status")).toBe("needs_review");
    expect(screen.getByTestId("reading-source-status").textContent).toBe(i18n.t("reading.sourceNeedsReview"));
    fireEvent.click(screen.getByTestId("reading-source-back"));
    expect(back).toHaveBeenCalled();
  });

  it("offers matching with Bangumi in the settings panel only when the shell gives it", () => {
    const match = vi.fn();
    pane({});
    fireEvent.click(screen.getByTestId("reading-settings"));
    expect(screen.queryByTestId("reader-match")).toBeNull();
    cleanup();
    pane({}, { onMatch: match });
    expect(screen.queryByTestId("reader-match")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-settings"));
    expect(screen.getByTestId("reading-settings-panel").contains(screen.getByTestId("reader-match"))).toBe(true);
    fireEvent.click(screen.getByTestId("reader-match"));
    expect(match).toHaveBeenCalledTimes(1);
  });

  it("puts the tools, the part number and the progress mark in the bottom bar, with no previous or next part button, and keeps continue-reading with the text (AT-83)", () => {
    const part = vi.fn();
    const progress = vi.fn();
    render(
      <ReadingPane
        document={{ ...doc("甲乙丙"), parts: [{ id: "a", kind: "text", length: 3, textLayer: true }, { id: "body", kind: "text", length: 3, textLayer: true }, { id: "c", kind: "text", length: 3, textLayer: true }] }}
        style={{ ...baseStyle }} labels={readingLabels(i18n)} t={i18n.t} labelsExtra={{ sourceNeedsReview: "", sourceMissing: "", sourceRepair: "" }}
        hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
        onSearch={() => {}} onJump={() => {}} onProgress={progress} onMore={() => {}} onPart={part} onSelect={() => {}}
        onStyle={() => {}} onBookmark={() => {}} onRemoveBookmark={() => {}} onOpenBookmark={() => {}} onBackToNote={() => {}} onRepair={() => {}}
      />,
    );
    const foot = screen.getByTestId("reading-footer");
    for (const id of ["reading-part-position", "reading-panel-toc", "reading-panel-search", "reading-panel-bookmarks", "reading-bookmark-add", "reading-fullscreen", "reading-settings", "reading-progress"]) expect(foot.contains(screen.getByTestId(id)), id).toBe(true);
    for (const gone of ["reading-prev", "reading-next", "reading-spread-prev", "reading-spread-next"]) expect(screen.queryByTestId(gone), gone).toBeNull();
    expect(foot.contains(screen.getByTestId("reading-more"))).toBe(false);
    expect(screen.getByTestId("reading-scroll").contains(screen.getByTestId("reading-more"))).toBe(true);
    // The part is chosen by its number, typed into the position itself; the table of contents is the other way.
    expect(screen.getByTestId("reading-part-position").textContent).toContain("2 / 3");
    fireEvent.click(screen.getByTestId("reading-part-position"));
    const input = screen.getByTestId("reading-part-input") as HTMLInputElement;
    expect(input.value).toBe("2");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(part).toHaveBeenCalledWith("c", 0);
    // A number outside the book keeps the field open.
    fireEvent.click(screen.getByTestId("reading-part-position"));
    fireEvent.change(screen.getByTestId("reading-part-input"), { target: { value: "9" } });
    fireEvent.keyDown(screen.getByTestId("reading-part-input"), { key: "Enter" });
    expect(screen.getByTestId("reading-part-input").getAttribute("aria-invalid")).toBe("true");
    expect(part).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("reading-progress"));
    expect(progress).toHaveBeenCalled();
  });
});

describe("novel reader controls get out of the way while reading (A-63)", () => {
  const shown = () => screen.getByTestId("reading-page").getAttribute("data-controls");
  const later = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  /** jsdom has no layout: give the reader a 800 px high box so "the top edge" and "the middle" mean something. */
  const sized = () => {
    const root = screen.getByTestId("reading-page");
    root.getBoundingClientRect = () => ({ top: 0, bottom: 800, left: 0, right: 600, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) });
    return root;
  };

  it("knows when the pointer is at the top or the bottom edge", () => {
    const box = { top: 100, bottom: 900 };
    expect(inEdge(110, box)).toBe(true);
    expect(inEdge(890, box)).toBe(true);
    expect(inEdge(500, box)).toBe(false);
    expect(inEdge(100 + 64, box)).toBe(true);
    expect(inEdge(100 + 65, box)).toBe(false);
  });

  it("hides after a moment of reading and comes back at the top edge, at the bottom edge and on a key press, but not for a pointer in the middle", () => {
    vi.useFakeTimers();
    pane({});
    const root = sized();
    expect(shown()).toBe("shown");
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    fireEvent.pointerMove(root, { clientY: 400 });
    expect(shown()).toBe("hidden");
    fireEvent.pointerMove(root, { clientY: 20 });
    expect(shown()).toBe("shown");
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    fireEvent.pointerMove(root, { clientY: 790 });
    expect(shown()).toBe("shown");
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(shown()).toBe("shown");
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    // A modifier on its own is not a sign of use.
    fireEvent.keyDown(window, { key: "Shift" });
    expect(shown()).toBe("hidden");
  });

  it("stays while a panel is open or focus is inside the controls, and counts down again once they are put away", () => {
    vi.useFakeTimers();
    pane({});
    sized();
    // jsdom answers :focus-visible with a browser's own guess about the last input; this test is about what the controls do with keyboard focus, so it is told yes.
    const matches = Element.prototype.matches;
    const focusVisible = vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) { return selector === ":focus-visible" ? true : matches.call(this, selector); });
    fireEvent.click(screen.getByTestId("reading-settings"));
    later(AUTO_HIDE_MS * 3);
    expect(shown()).toBe("shown");
    fireEvent.keyDown(document, { key: "Escape" });
    // Esc gives the focus back to the button that opened the panel, and a control the keyboard is on holds the bar.
    expect(document.activeElement).toBe(screen.getByTestId("reading-settings"));
    later(AUTO_HIDE_MS * 3);
    expect(shown()).toBe("shown");
    act(() => screen.getByTestId("reading-settings").blur());
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    fireEvent.click(screen.getByTestId("reading-panel-toc"));
    expect(shown()).toBe("shown");
    later(AUTO_HIDE_MS * 3);
    expect(shown()).toBe("shown");
    fireEvent.click(screen.getByTestId("reading-panel-toc"));
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    // Tabbing onto a hidden control brings the bar back, and it stays while the control has focus.
    act(() => screen.getByTestId("reading-panel-search").focus());
    expect(shown()).toBe("shown");
    later(AUTO_HIDE_MS * 3);
    expect(shown()).toBe("shown");
    act(() => screen.getByTestId("reading-panel-search").blur());
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    focusVisible.mockRestore();
  });

  it("stays while the pointer rests on the controls", () => {
    vi.useFakeTimers();
    pane({});
    sized();
    const bar = screen.getByTestId("reading-footer");
    fireEvent.pointerEnter(bar);
    later(AUTO_HIDE_MS * 3);
    expect(shown()).toBe("shown");
    fireEvent.pointerLeave(bar);
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
  });

  it("keeps the controls in the document, and the body's text and position, while they are hidden", () => {
    vi.useFakeTimers();
    pane({});
    sized();
    later(AUTO_HIDE_MS + 50);
    expect(shown()).toBe("hidden");
    // Hidden means moved out of sight: keyboard users can still Tab to them.
    expect(screen.getByTestId("reading-panel-toc").hasAttribute("hidden")).toBe(false);
    expect(screen.getByTestId("reading-body").textContent).toBe("甲乙丙\n丁戊己");
  });
});
