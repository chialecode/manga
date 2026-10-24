import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { stay } from "./app-host.ts";

/** What a test of the whole window needs to find its way around the single workspace: the tabs, the one in front, and the library tab's shelves. */

/** The workspace of the context that is on screen: the others stay mounted behind it, hidden. */
export const activeHost = () => document.querySelector<HTMLElement>("[data-testid='context-host'][data-active='true']");

const tabs = () => Array.from((activeHost() ?? document).querySelectorAll<HTMLElement>("[data-testid='tab']"));

/** The names of the tabs of the context on screen, in the order they stand, column after column. */
export const tabTitles = () => tabs().map((node) => node.querySelector(".tab-title")?.textContent ?? "");

/** The tab in front (the one that has the focus, in the column that has it). */
export const focusedTab = () => tabs().find((node) => node.getAttribute("data-focused") === "true") ?? null;
export const focusedTitle = () => focusedTab()?.querySelector(".tab-title")?.textContent ?? "";

/** The tab with this name, wherever it stands. */
export const tabNamed = (title: string | RegExp) => tabs().find((node) => {
  const text = node.querySelector(".tab-title")?.textContent ?? "";
  return typeof title === "string" ? text === title : title.test(text);
}) ?? null;

/** Brings a tab to the front the way a click on its title does (the dock takes the press on the next frame), and waits until it is in front. */
export async function showTab(title: string | RegExp) {
  const tab = tabNamed(title);
  if (!tab) throw new Error(`no tab named ${String(title)}`);
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  await waitFor(() => expect(tabNamed(title)?.getAttribute("data-focused")).toBe("true"));
}

/** Closes the tab in front from its own button. */
export function closeFocusedTab() {
  const tab = focusedTab();
  if (!tab) throw new Error("no tab is in front");
  fireEvent.click(tab.querySelector("[data-testid='tab-close']")!);
}

/** The page of the tab in front. */
export const focusedPanel = () => (activeHost() ?? document).querySelector<HTMLElement>("[data-testid='tab-panel'][data-focused='true'][data-visible='true']");

/**
 * From a window that has just come up to the shelf of one medium, in the library tab that is open at the start: the overview lists each medium with a
 * "view all", and that is the way to its shelf. Waits for the pause that the tab's history takes before it counts a place as visited.
 */
export async function openShelf(kind: "novel" | "comic" | "video") {
  await waitFor(() => expect(screen.getByTestId(`section-all-${kind}`)).toBeTruthy());
  await stay();
  fireEvent.click(screen.getByTestId(`section-all-${kind}`));
  await waitFor(() => expect(screen.getByTestId(`shelf-${kind}`)).toBeTruthy());
}

/** Goes on to a work's own page from a card of the shelf that is open. */
export async function openWorkPage(cardId: string) {
  await waitFor(() => expect(screen.getByTestId(cardId)).toBeTruthy());
  await stay();
  fireEvent.click(screen.getByTestId(cardId));
  await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
  await waitFor(() => expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(false));
  await stay();
}

/** The title bar's back button for the tab in front: ready once the place the tab is on has settled into its history. */
export async function goBack() {
  await waitFor(() => expect(screen.getByTestId("nav-back")).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByTestId("nav-back"));
}

/** Lets what a tab does on its way out (saving the place) and what React does after it happen. */
export async function settle() {
  await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); });
}
