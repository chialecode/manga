/** Natural order without anything else of the name parser, for code that must stay small (light open, A-128). */
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

/** Natural order: digit runs compare as numbers, so `2` sorts before `10`; names compare with locale rules. */
export function naturalCompare(left: string, right: string): number {
  return collator.compare(left, right);
}

/** Paths with `/` separators: each segment compares naturally, so "vol 2/…" comes before "vol 10/…". */
export function comparePaths(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const diff = naturalCompare(a[i]!, b[i]!);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}
