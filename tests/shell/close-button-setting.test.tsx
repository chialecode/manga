/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { installHost } from "../helpers/app-host.ts";

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

// A-136: where the window has a tray icon, Settings > General says what its close button does, into the tray or out of MANGA.
function host(tray: boolean) {
  const saved = { closeToTray: true };
  const installed = installHost({
    tray,
    overrides: {
      "settings.getShell": () => ({ window: { ...saved } }),
      "settings.setShell": (input) => { Object.assign(saved, (input.window as object | undefined) ?? {}); return { window: { ...saved } }; },
    },
  });
  return { ...installed, saved };
}

const general = async () => {
  fireEvent.click(await screen.findByTestId("nav-settings"));
  fireEvent.click(await screen.findByTestId("settings-nav-general"));
  await screen.findByTestId("general-startup");
};

describe("the close button's choice on Settings > General (A-136)", () => {
  it("starts on the tray, and saves the choice to quit and back", async () => {
    const { calls, saved } = host(true);
    render(<App />);
    await general();
    const select = await screen.findByTestId<HTMLSelectElement>("general-close-button");
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("tray");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["最小化到托盘", "退出 MANGA"]);
    fireEvent.change(select, { target: { value: "quit" } });
    await waitFor(() => expect(saved.closeToTray).toBe(false));
    expect(select.value).toBe("quit");
    fireEvent.change(select, { target: { value: "tray" } });
    await waitFor(() => expect(saved.closeToTray).toBe(true));
    expect(calls.filter((call) => call.commandId === "settings.setShell" && call.input.window).map((call) => call.input)).toEqual([{ window: { closeToTray: false } }, { window: { closeToTray: true } }]);
  });

  it("is not offered where the window has no tray icon", async () => {
    host(false);
    render(<App />);
    await general();
    expect(screen.queryByTestId("general-window")).toBeNull();
    expect(screen.queryByTestId("general-close-button")).toBeNull();
  });
});
