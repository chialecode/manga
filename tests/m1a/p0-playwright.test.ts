import { describe, expect, it } from "vitest";

describe("P0 playwright-core wiring", () => {
  it("exposes chromium without requiring a downloaded browser in CI", async () => {
    const playwright = await import("playwright-core");
    expect(typeof playwright.chromium.launch).toBe("function");
    const exe = playwright.chromium.executablePath();
    expect(typeof exe === "string").toBe(true);
  });
});
