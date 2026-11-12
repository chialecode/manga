/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LightApp } from "../../apps/desktop/src/light/light-app.tsx";
import type { LightHost, LightState } from "../../apps/desktop/src/light/light-host.ts";
import { installMatchMedia, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

beforeEach(() => {
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
});

afterEach(() => {
  cleanup();
  removeMatchMedia();
  delete (window as unknown as { mangaLight?: LightHost }).mangaLight;
});

function installLightHost(initial: LightState, overrides: Partial<LightHost> = {}) {
  let current = initial;
  const listeners = new Set<() => void>();
  const host: LightHost = {
    state: async () => current,
    openDialog: async () => current,
    openDropped: async () => {
      current = { ...current, opened: null, error: { kind: "unsupported", detail: "notes.txt" } };
      return current;
    },
    sibling: async () => ({ moved: false }),
    reveal: async () => undefined,
    position: async () => undefined,
    onChanged: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    onSaveNow: () => () => undefined,
    ...overrides,
  };
  (window as unknown as { mangaLight: LightHost }).mangaLight = host;
  return {
    host,
    set(next: LightState) {
      current = next;
      for (const fn of listeners) fn();
    },
  };
}

const EMPTY_STATE: LightState = {
  opened: null,
  error: null,
  resume: null,
  version: "0.1.1",
  types: {
    video: [".mp4", ".mkv"],
    comic: [".cbz"],
    image: [".png", ".jpg"],
  },
};

describe("LightApp window shell, unsupported drop, and menu (AT-167, 4.4, 6)", () => {
  it("shows the empty drag-and-drop prompt with supported types, explains an unsupported dropped file in-window, and opens About (AT-167)", async () => {
    installLightHost(EMPTY_STATE);
    render(<LightApp />);

    expect(await screen.findByTestId("light-empty")).toBeTruthy();
    expect(screen.getByTestId("light-types").textContent).toContain("mp4");
    expect(screen.getByTestId("light-open")).toBeTruthy();

    // Drag and drop an unsupported text file onto the window: shows inline unsupported message and supported types, no system dialog.
    const file = new File(["plain text"], "notes.txt", { type: "text/plain" });
    fireEvent.dragOver(window, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.getByTestId("light-shell").getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(window, { dataTransfer: { types: ["Files"], files: [file] } });

    await waitFor(() => {
      const err = screen.getByTestId("light-error");
      expect(err.getAttribute("data-error")).toBe("unsupported");
      expect(err.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    });
    expect(screen.getByTestId("light-types").textContent).toContain("png");

    // Menu -> About dialog shows version and closes cleanly.
    fireEvent.click(screen.getByTestId("light-menu"));
    const items = await screen.findAllByRole("menuitem");
    const aboutItem = items.find((node) => node.textContent?.includes("关于"));
    expect(aboutItem).toBeTruthy();
    fireEvent.click(aboutItem!);
    const dialog = await screen.findByTestId("light-about");
    expect(dialog.textContent).toContain("0.1.1");
    fireEvent.click(dialog.querySelector("button")!);
    expect(screen.queryByTestId("light-about")).toBeNull();
  });
});
