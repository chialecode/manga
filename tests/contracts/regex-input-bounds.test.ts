import { describe, expect, it } from "vitest";
import { classifySearchInput, parseBangumiRef } from "../../packages/contracts/src/bangumi-ref.ts";
import { validPattern } from "../../packages/contracts/src/inputs-danmaku.ts";
import { providerReason } from "../../packages/model-protocol/src/http.ts";
import { checkAppUpdateConfig } from "../../packages/app-core/src/update/signature.ts";
import { htmlToText } from "../../packages/app-core/src/domain/formats.ts";

const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);

/** Runs `work` and fails if it takes longer than `ms`: a backtracking regex takes seconds on these inputs. */
function quick<T>(work: () => T, ms = 250): T {
  const started = performance.now();
  const result = work();
  expect(performance.now() - started).toBeLessThan(ms);
  return result;
}

describe("text from outside is matched in linear time", () => {
  it("parses Bangumi references with long runs of slashes, ? and #", () => {
    expect(quick(() => parseBangumiRef("/".repeat(50_000) + "x"))).toMatchObject({ ok: false });
    expect(quick(() => classifySearchInput("#".repeat(50_000) + NL))).toBeTruthy();
    expect(parseBangumiRef("bgm.tv/subject/12345/?a=1#top")).toMatchObject({ ok: true });
    expect(parseBangumiRef("/subject/12345///")).toMatchObject({ ok: true });
  });

  it("checks danmaku filter patterns without a quadratic pre-check", () => {
    expect(quick(() => validPattern("(" + "a".repeat(50_000)))).toBe(false);
    expect(validPattern("(a+)+")).toBe(false);
    expect(validPattern("(x|y+)*")).toBe(false);
    expect(validPattern("(ab){2}")).toBe(true);
    expect(validPattern("(a+)b")).toBe(true);
  });

  it("drops a service's request id without scanning whitespace twice", () => {
    const body = JSON.stringify({ error: { message: "slow down" + TAB.repeat(50_000) + "x" } });
    expect(quick(() => providerReason(body))).toBeTruthy();
    expect(providerReason(JSON.stringify({ error: { message: "rate limited (request_id: abc-1)  " } }))).toBe("rate limited");
  });

  it("reads publisherName lists line by line", () => {
    const base = ["provider: github", "owner: chialecode", "repo: manga", "updaterCacheDirName: updater"];
    const crafted = [...base, "publisherName:", ...Array.from({ length: 5_000 }, () => "  - x"), "  - y z"].join(NL);
    expect(quick(() => checkAppUpdateConfig(crafted))).toContain("missing publisherName chialecode");
    expect(checkAppUpdateConfig([...base, "publisherName:", "  - other", "", "  - chialecode"].join(NL))).toEqual([]);
    expect(checkAppUpdateConfig([...base, "publisherName: chialecode"].join(NL))).toEqual([]);
    expect(checkAppUpdateConfig([...base, "publisherName:", "  - other"].join(NL))).toContain("missing publisherName chialecode");
  });

  it("removes script blocks whose end tag carries whitespace", () => {
    expect(htmlToText("<p>a</p><script>alert(1)</script ><p>b</p>").text).not.toContain("alert");
  });
});
