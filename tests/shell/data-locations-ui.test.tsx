/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { GeneralPage } from "../../apps/desktop/src/renderer/pages/settings/general-page.tsx";
import { LOCATION_GROUPS } from "../../apps/desktop/src/renderer/pages/settings/location-groups.tsx";
import type { HostState } from "../../apps/desktop/src/renderer/lib/api.ts";
import { LOCATION_PARTITIONS } from "@manga/contracts";

// AT-148 / AT-149 in the settings: every partition's folder under the group it belongs to, one that stayed at the old place marked, and the clean-up of
// the old place only after the person confirms it. Paths are synthetic.

const i18n = createTranslator("zh-CN");
afterEach(() => { cleanup(); });

const app = "/x/Local/manga";
const files = "/x/Docs/MANGA";
const host = (overrides: Record<string, string> = {}): HostState => ({
  writable: true,
  vaultAvailable: true,
  layout: {
    channel: "release", pointerPath: `${app}/launcher/pointer.json`, writable: true, recovery: "none", appRoot: app, filesRoot: files, overrides,
    partitions: {
      data: `${app}/data`, backups: `${app}/backups`, logs: `${app}/logs`, cache: `${app}/cache`, runtime: `${app}/runtime`,
      works: overrides.works ?? `${files}/works`, projects: `${files}/projects`, attachments: `${files}/attachments`, resources: `${files}/resources`, exports: `${files}/exports`,
      downloads: "/x/Downloads/MANGA",
    },
  },
});

function mount(settings: Record<string, unknown>, layout = host(), onCleanLegacy = vi.fn(async () => null)) {
  render(<GeneralPage i18n={i18n} host={layout} settings={settings} migration={null} onChooseLocation={vi.fn()} onPointerLocation={vi.fn()} onIndexedRoot={vi.fn()}
    onApplyMigration={vi.fn()} onCancelMigration={vi.fn()} onRollbackRecovery={vi.fn()} onRecoverJobs={vi.fn()} onCleanLegacy={onCleanLegacy} onGoto={vi.fn()} />);
  return { onCleanLegacy };
}

describe("where the data lives, in the settings (AT-148, AT-149)", () => {
  it("names every partition exactly once, under the application's data, the person's files or the downloads", () => {
    expect(LOCATION_GROUPS.flatMap((group) => group.partitions).sort()).toEqual([...LOCATION_PARTITIONS].sort());
    mount({});
    expect(within(screen.getByTestId("location-group-app")).getByTestId("location-path-data").textContent).toBe(`${app}/data`);
    expect(within(screen.getByTestId("location-group-files")).getByTestId("location-path-works").textContent).toBe(`${files}/works`);
    expect(within(screen.getByTestId("location-group-downloads")).getByTestId("location-path-downloads").textContent).toBe("/x/Downloads/MANGA");
    expect(screen.getByRole("group", { name: "应用数据" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "你的文件" })).toBeTruthy();
    expect(screen.getByTestId("location-path-works").getAttribute("data-override")).toBeNull();
    expect(screen.queryByTestId("general-legacy")).toBeNull();
  });

  it("marks a partition that stayed at the old place, and cleans the old place only after asking", async () => {
    const { onCleanLegacy } = mount({ legacyLocation: { root: "/x/Docs/MANGA/release", bytes: 50 * 1024 * 1024, cleaned: false } }, host({ works: "/x/Docs/MANGA/release/works" }));
    expect(screen.getByTestId("location-path-works").textContent).toBe("/x/Docs/MANGA/release/works");
    expect(screen.getByTestId("location-path-works").getAttribute("data-override")).toBe("true");
    expect(screen.getByTestId("general-legacy").textContent).toContain("/x/Docs/MANGA/release");
    expect(screen.getByTestId("general-legacy").textContent).toContain("50 MB");
    fireEvent.click(screen.getByTestId("general-legacy-clean"));
    expect(onCleanLegacy).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain("你的文件");
    fireEvent.click(screen.getByTestId("general-legacy-clean-confirm"));
    await waitFor(() => expect(onCleanLegacy).toHaveBeenCalledTimes(1));
  });

  it("offers nothing once the old place was cleaned", () => {
    mount({ legacyLocation: { root: "/x/Docs/MANGA/release", bytes: 0, cleaned: true } });
    expect(screen.queryByTestId("general-legacy")).toBeNull();
  });
});
