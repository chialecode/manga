import { describe, expect, it } from "vitest";
import { SEGMENTATIONS, chunkText, estimateChunks, isSegmentation } from "../../packages/app-core/src/semantic/chunk.ts";

const slice = (text: string, start: number, end: number) => Array.from(text).slice(start, end).join("");

describe("cutting text into pieces for the semantic index", () => {
  it("keeps a short text whole and gives nothing for an empty or blank one", () => {
    expect(chunkText("一句话。", 600)).toEqual([{ start: 0, end: 4, text: "一句话。" }]);
    expect(chunkText("", 600)).toEqual([]);
    expect(chunkText(" \n\t \n", 600)).toEqual([]);
  });

  it("packs whole sentences up to the limit and never splits one that fits", () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `这是第${i}句话，内容不长。`);
    const text = sentences.join("");
    const chunks = chunkText(text, 60);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect([...chunk.text].length).toBeLessThanOrEqual(60);
      expect(chunk.text.endsWith("。")).toBe(true);
      expect(chunk.text.startsWith("这是第")).toBe(true);
    }
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
  });

  it("gives offsets in code points that cut the original text back out, emoji and all", () => {
    const text = "😀开头一句。\n\n第二段有😀表情，也有字母 abc。第三句？ 结尾！";
    for (const size of [8, 12, 600]) {
      const chunks = chunkText(text, size);
      for (const chunk of chunks) expect(slice(text, chunk.start, chunk.end)).toBe(chunk.text);
      // The pieces are in order, do not overlap, and between them hold every character that is not whitespace.
      for (let i = 1; i < chunks.length; i += 1) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end);
      expect(chunks.map((chunk) => chunk.text).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
    }
  });

  it("cuts a sentence that is longer than a piece at the limit, after the pieces packed before it", () => {
    const long = "字".repeat(130);
    const chunks = chunkText(`前一句。${long}。后一句。`, 50);
    expect(chunks.map((chunk) => [...chunk.text].length)).toEqual([4, 50, 50, 31, 4]);
    expect(chunks[0]!.text).toBe("前一句。");
    expect(chunks.at(-1)!.text).toBe("后一句。");
  });

  it("treats a line break as the end of a unit, keeps closing quotes with their sentence, and does not break a decimal point", () => {
    expect(chunkText("第一行\n第二行\n第三行", 4).map((chunk) => chunk.text)).toEqual(["第一行", "第二行", "第三行"]);
    expect(chunkText("他说：“走吧。”然后离开了。", 8).map((chunk) => chunk.text)).toEqual(["他说：“走吧。”", "然后离开了。"]);
    expect(chunkText("pi is 3.14 and e is 2.72. Done.", 14).map((chunk) => chunk.text)).toEqual(["pi is 3.14 and", "e is 2.72.", "Done."]);
    expect(chunkText("pi is 3.14 ok.", 600)).toHaveLength(1);
  });

  it("names the segmentations it offers, and estimates how many pieces a text will make", () => {
    expect(Object.keys(SEGMENTATIONS)).toEqual(["paragraph-300", "paragraph-600", "paragraph-1200"]);
    expect(isSegmentation("paragraph-600")).toBe(true);
    expect(isSegmentation("sentence")).toBe(false);
    expect(estimateChunks(0, 600)).toBe(1);
    expect(estimateChunks(4800, 600)).toBe(10);
    expect(estimateChunks(4800, 300)).toBeGreaterThan(estimateChunks(4800, 600));
  });
});
