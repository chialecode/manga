import { describe, expect, it } from "vitest";
import { readerHeading } from "../../apps/desktop/src/renderer/hooks/use-novel.ts";

describe("the title bar over a book", () => {
  it("names the work, and adds the file's own name only when the work has several (a folder of chapters) (AT-83)", () => {
    // A folder of chapter files is one work: the bar names the work, then the chapter that is open.
    expect(readerHeading("第一章", { title: "合成长篇", many: true })).toBe("合成长篇 第一章");
    // One file is the whole work; its name is not repeated, and a renamed or linked work wins over the file's name.
    expect(readerHeading("合成小说乙", { title: "合成小说乙", many: false })).toBe("合成小说乙");
    expect(readerHeading("book-final-v2", { title: "合成小说乙", many: false })).toBe("合成小说乙");
    // The chapter is never said twice.
    expect(readerHeading("合成长篇", { title: "合成长篇", many: true })).toBe("合成长篇");
    // Before the work is known, or when it has no name, the book's own name is all there is.
    expect(readerHeading("第一章", null)).toBe("第一章");
  });
});
