/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts";
import { frame, shellRail } from "../helpers/shell-frame.tsx";

afterEach(() => cleanup());

const folded = () => {
  const preference = structuredClone(DEFAULT_SHELL_PREFERENCE);
  preference.sidebar.visible = false;
  return preference;
};
const card = () => screen.getByTestId("shell-sidebar");
const slot = () => within(card()).getByTestId("sidebar-slot");
const LATE = { timeout: 1500 };

describe("AT-120 the rail's icons: taking one out, \"…\" and the pin", () => {
  it("takes an icon out from its right-click menu, and offers no menu on the home", () => {
    const hide = vi.fn();
    frame(1280, 840, { rail: shellRail({ onHide: hide }) });
    fireEvent.contextMenu(screen.getByTestId("nav-home"), { clientX: 20, clientY: 60 });
    expect(screen.queryByTestId("rail-menu")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("nav-comic"), { clientX: 20, clientY: 120 });
    const menu = screen.getByTestId("rail-menu");
    expect(within(menu).getAllByRole("menuitem").map((node) => (node.textContent ?? "").trim())).toEqual(["从图标栏隐藏"]);
    fireEvent.click(within(menu).getByRole("menuitem"));
    expect(hide).toHaveBeenCalledWith("comic");
    expect(screen.queryByTestId("rail-menu")).toBeNull();
  });

  it("has no \"…\" while every icon is in, and lists the ones taken out behind it, each with a pin that puts it back", () => {
    const pin = vi.fn();
    const select = vi.fn();
    frame(1280, 840, { rail: shellRail({ hidden: ["comic", "video"], onPin: pin, onSelect: select }) });
    // The icons that are out are not in the rail; the others are, in their order, and "…" follows them.
    expect(screen.queryByTestId("nav-comic")).toBeNull();
    expect(screen.queryByTestId("nav-video")).toBeNull();
    const views = [...screen.getByTestId("rail-views").querySelectorAll("[data-rail-view]")].map((node) => node.getAttribute("data-rail-view"));
    expect(views).toEqual(["home", "conversation", "novel", "note", "whiteboard", "more"]);
    const more = screen.getByTestId("rail-more");
    expect(more.getAttribute("aria-label")).toBe("更多功能");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const list = screen.getByTestId("rail-more-list");
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(list).getAllByRole("menuitem").map((node) => node.getAttribute("data-testid"))).toEqual(["rail-more-comic", "rail-pin-comic", "rail-more-video", "rail-pin-video"]);
    expect(screen.getByTestId("rail-pin-comic").getAttribute("aria-label")).toBe("把“漫画”固定到图标栏");
    // The pin puts it back without choosing it; a click on the name goes straight to the view and closes the list.
    fireEvent.click(screen.getByTestId("rail-pin-comic"));
    expect(pin).toHaveBeenCalledWith("comic");
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("rail-more-video"));
    expect(select).toHaveBeenCalledWith("video");
    expect(screen.queryByTestId("rail-more-list")).toBeNull();
  });

  it("marks \"…\" while the view of the sidebar is one of the icons behind it", () => {
    frame(1280, 840, { rail: shellRail({ hidden: ["video", "comic"], current: "video" }) });
    expect(screen.getByTestId("rail-more").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("rail-more"));
    expect(screen.getByTestId("rail-more-video").getAttribute("aria-current")).toBe("page");
    // Only what is out of the rail is in the list.
    expect(screen.getByTestId("rail-more-list").querySelectorAll("[data-rail-more-row]").length).toBe(2);
  });

  it("moves in the list with the arrow keys, reaches a pin from its name and back, and closes with Escape to the \"…\" button", () => {
    frame(1280, 840, { rail: shellRail({ hidden: ["comic", "video"] }) });
    const more = screen.getByTestId("rail-more");
    more.focus();
    fireEvent.keyDown(more, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("rail-more-comic"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("rail-more-video"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("rail-pin-video"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByTestId("rail-more-video"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("rail-more-comic"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("rail-more-list")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("puts the icons that do not fit a short window behind \"…\" with no pin, and shows them again in a taller one", () => {
    frame(1280, 300);
    const shown = [...screen.getByTestId("rail-views").querySelectorAll("[data-rail-view]")].map((node) => node.getAttribute("data-rail-view"));
    expect(shown[0]).toBe("home");
    expect(shown.at(-1)).toBe("more");
    expect(shown.length).toBeLessThan(8);
    expect(screen.getByTestId("nav-settings")).toBeTruthy();
    fireEvent.click(screen.getByTestId("rail-more"));
    const rows = within(screen.getByTestId("rail-more-list")).getAllByRole("menuitem");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((node) => (node.getAttribute("data-testid") ?? "").startsWith("rail-more-"))).toBe(true);
    expect(screen.queryByTestId("rail-pin-whiteboard")).toBeNull();
    cleanup();
    frame(1280, 900);
    expect(screen.queryByTestId("rail-more")).toBeNull();
    expect(screen.getByTestId("nav-whiteboard")).toBeTruthy();
  });
});

describe("AT-120 the card of a view, with the sidebar folded away", () => {
  it("comes out after the pointer rests on an icon, shows that view the way a card does, and goes when the pointer leaves", async () => {
    frame(1600, 900, { preference: folded() });
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    const icon = screen.getByTestId("nav-comic");
    fireEvent.mouseEnter(icon);
    // Not at once: a pointer that passes over the rail brings nothing out.
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    await waitFor(() => expect(card().getAttribute("data-shell-state")).toBe("overlay"), LATE);
    expect(card().className).toContain("shell-card");
    expect(card().getAttribute("data-view")).toBe("comic");
    expect(slot().getAttribute("data-view")).toBe("comic");
    expect(slot().getAttribute("data-variant")).toBe("card");
    fireEvent.mouseLeave(icon);
    await waitFor(() => expect(screen.queryByTestId("shell-sidebar")).toBeNull(), LATE);
  });

  it("brings out nothing for a pointer that passes over an icon", async () => {
    frame(1600, 900, { preference: folded() });
    const icon = screen.getByTestId("nav-video");
    fireEvent.mouseEnter(icon);
    fireEvent.mouseLeave(icon);
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
  });

  it("stays while the pointer goes from the icon onto the card, can be worked in, and changes to the next icon's view", async () => {
    frame(1600, 900, { preference: folded() });
    fireEvent.mouseEnter(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.queryByTestId("shell-sidebar")).not.toBeNull(), LATE);
    // Leaving an icon for the card is not leaving: the card stays, and later still.
    fireEvent.mouseLeave(screen.getByTestId("nav-comic"), { relatedTarget: card() });
    fireEvent.mouseEnter(card());
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(slot().getAttribute("data-view")).toBe("comic");
    // From the card to another icon: its view takes the card's place.
    fireEvent.mouseLeave(card(), { relatedTarget: screen.getByTestId("nav-note") });
    fireEvent.mouseEnter(screen.getByTestId("nav-note"));
    await waitFor(() => expect(slot().getAttribute("data-view")).toBe("note"), LATE);
    expect(screen.getAllByTestId("sidebar-slot").length).toBe(1);
    // Off the card and the icon: it goes.
    fireEvent.mouseLeave(screen.getByTestId("nav-note"));
    await waitFor(() => expect(screen.queryByTestId("shell-sidebar")).toBeNull(), LATE);
  });

  it("keeps the sidebar folded when an icon is clicked: the view is chosen, the card follows it, and nothing is docked", async () => {
    const select = vi.fn();
    const show = vi.fn();
    frame(1600, 900, { preference: folded(), onShow: show, rail: shellRail({ onSelect: select }) });
    fireEvent.mouseEnter(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.queryByTestId("shell-sidebar")).not.toBeNull(), LATE);
    fireEvent.click(screen.getByTestId("nav-comic"), { detail: 1 });
    expect(select).toHaveBeenCalledWith("comic");
    expect(show).not.toHaveBeenCalled();
    // The card is still the pointer's: it stays over the icon, and the sidebar column is still not in the layout.
    expect(card().getAttribute("data-shell-state")).toBe("overlay");
    expect(screen.queryByTestId("shell-resize-sidebar")).toBeNull();
  });

  it("closes the card when something in it was opened, and tells the content so", async () => {
    frame(1600, 900, { preference: folded() });
    fireEvent.mouseEnter(screen.getByTestId("nav-comic"));
    await waitFor(() => expect(screen.queryByTestId("shell-sidebar")).not.toBeNull(), LATE);
    fireEvent.click(screen.getByTestId("slot-opened"));
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
  });

  it("opens from the keyboard with Enter or Space on an icon, takes the focus, and Escape gives it back to the icon", () => {
    const select = vi.fn();
    frame(1600, 900, { preference: folded(), rail: shellRail({ onSelect: select }) });
    const icon = screen.getByTestId("nav-video");
    icon.focus();
    // A key press on a button is a click with no pointer: its detail is 0.
    fireEvent.click(icon, { detail: 0 });
    expect(select).toHaveBeenCalledWith("video");
    expect(card().getAttribute("data-shell-state")).toBe("overlay");
    expect(slot().getAttribute("data-view")).toBe("video");
    expect(document.activeElement).toBe(card());
    // Pinned: the pointer leaving does not take it away.
    fireEvent.mouseLeave(card());
    expect(screen.queryByTestId("shell-sidebar")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(document.activeElement).toBe(icon);
  });

  it("leaves a card that was opened by a key when the page outside it is pressed, and not when something of the rail or the card is", () => {
    frame(1600, 900, { preference: folded() });
    fireEvent.click(screen.getByTestId("nav-note"), { detail: 0 });
    expect(screen.queryByTestId("shell-sidebar")).not.toBeNull();
    fireEvent.pointerDown(screen.getByTestId("slot-opened"));
    fireEvent.pointerDown(screen.getByTestId("nav-note"));
    expect(screen.queryByTestId("shell-sidebar")).not.toBeNull();
    fireEvent.pointerDown(screen.getByTestId("main-slot"));
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
  });

  it("opens the card of the current view from the sidebar's switch at once, without docking the sidebar", () => {
    const show = vi.fn();
    frame(1600, 900, { preference: folded(), onShow: show, rail: shellRail({ current: "note" }) });
    fireEvent.mouseEnter(screen.getByTestId("shell-sidebar-toggle"));
    expect(card().getAttribute("data-shell-state")).toBe("overlay");
    expect(slot().getAttribute("data-view")).toBe("note");
    expect(show).not.toHaveBeenCalled();
  });

  it("is also what a window too narrow for the sidebar shows, and nothing comes out in the window-fullscreen state", async () => {
    frame(800, 700);
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("nav-video"));
    await waitFor(() => expect(slot().getAttribute("data-view")).toBe("video"), LATE);
    cleanup();
    frame(1600, 900, { preference: folded(), immersive: true });
    expect(screen.queryByTestId("shell-rail")).toBeNull();
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
  });

  it("shows the settings directory in a docked sidebar while the settings are on, even when the sidebar was folded away, and leaves it there", () => {
    frame(1600, 900, { preference: folded(), settings: true });
    expect(card().getAttribute("data-shell-state")).toBe("dock");
    expect(slot().getAttribute("data-view")).toBe("settings");
    expect(slot().getAttribute("data-variant")).toBe("dock");
    // The switch has nothing to fold while the settings stand.
    fireEvent.click(screen.getByTestId("shell-sidebar-toggle"));
    expect(card().getAttribute("data-shell-state")).toBe("dock");
  });
});
