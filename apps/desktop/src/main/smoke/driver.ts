import type { BrowserWindow } from "electron";

/** Small helpers that drive the real renderer from the main process (packaged-window smoke only). */

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In the page: the element with this test id that the window draws. A context or a tab out of sight keeps its page mounted, so the same test id can be in the
 * page several times and the first of them is not always the one a person sees; when none is drawn the first stands.
 */
export const PICK = `((id) => { const all = [...document.querySelectorAll('[data-testid="' + id + '"]')]; return all.find((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden") ?? all[0] ?? null; })`;

/**
 * Click the element once it exists and is enabled; pages fill in after their data arrives, so a missing (or still disabled) element
 * is waited for briefly.
 */
export async function clickTestId(view: BrowserWindow, testId: string, timeoutMs = 4000): Promise<boolean> {
  return view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = ${PICK}(${JSON.stringify(testId)});
      if (el && !el.disabled) {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
        resolve(true);
      } else if (Date.now() - started > ${timeoutMs}) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as Promise<boolean>;
}

/**
 * A click as the pointer makes it (`detail` 1). The icons of the rail take a click without a count (`detail` 0) for the keyboard's Enter or Space, which opens the
 * hover card and moves the focus into it, so what stands for the pointer on the rail is clicked with this one.
 */
export async function pointerClick(view: BrowserWindow, testId: string, timeoutMs = 4000): Promise<boolean> {
  return view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = ${PICK}(${JSON.stringify(testId)});
      if (el && !el.disabled) {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true, detail: 1 }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, cancelable: true, detail: 1 }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true, detail: 1 }));
        resolve(true);
      } else if (Date.now() - started > ${timeoutMs}) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as Promise<boolean>;
}

/**
 * A real mouse click at the element's centre: unlike a dispatched event it is trusted and carries user activation, which
 * browser APIs such as `requestFullscreen()` insist on. The window must be shown and the element in view.
 */
export async function trustedClick(view: BrowserWindow, testId: string, timeoutMs = 4000): Promise<boolean> {
  const point = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = ${PICK}(${JSON.stringify(testId)});
      const box = el && !el.disabled ? el.getBoundingClientRect() : null;
      if (box && box.width > 0 && box.height > 0) resolve({ x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) });
      else if (Date.now() - started > ${timeoutMs}) resolve(null);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as { x: number; y: number } | null;
  if (!point) return false;
  view.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  view.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  view.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return true;
}

/**
 * The novel reader's controls slide out of sight while the book is read. A pointer move near the reader's bottom edge (where the only bar is)
 * brings them back; the move is waited out, so what is measured or clicked next is where the controls rest.
 */
export async function revealNovelControls(view: BrowserWindow): Promise<boolean> {
  const shown = await view.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('[data-testid="reading-page"]');
    if (!root) return false;
    const box = root.getBoundingClientRect();
    root.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: box.left + box.width / 2, clientY: box.bottom - 12 }));
    return true;
  })()`) as boolean;
  if (shown) await sleep(260);
  return shown;
}

/**
 * A real key press (trusted, so it takes the same path as the keyboard): down, a pause while it is held, then up. A tap is a short hold;
 * a hold longer than the page's hold time is what the arrows treat as "keep going". Modifiers are not used by the callers.
 */
export async function pressKey(view: BrowserWindow, keyCode: string, heldMs = 40): Promise<void> {
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: "keyDown", keyCode });
  await sleep(heldMs);
  view.webContents.sendInputEvent({ type: "keyUp", keyCode });
}

/** Wait until a test id exists, optionally with an attribute equal to an expected value. */
export async function waitForTestId(view: BrowserWindow, testId: string, attribute = "data-present", expected: string | null = null, timeoutMs = 15_000): Promise<boolean> {
  return view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = ${PICK}(${JSON.stringify(testId)});
      const ok = el && (${expected === null ? "true" : `el.getAttribute("${attribute}") === ${JSON.stringify(expected)}`});
      if (ok) resolve(true);
      else if (Date.now() - started > ${timeoutMs}) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as Promise<boolean>;
}

/** Wait until a JavaScript expression about the document holds (polled in the page, so a busy main process does not delay it). */
export async function waitUntil(view: BrowserWindow, expression: string, timeoutMs = 8000): Promise<boolean> {
  return view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = Boolean(${expression}); } catch { ok = false; }
      if (ok) resolve(true);
      else if (Date.now() - started > ${timeoutMs}) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  })`) as Promise<boolean>;
}

/** Type into a React-controlled input or textarea the way a user does: through the native setter, then an input event. */
export async function setField(view: BrowserWindow, testId: string, value: string): Promise<boolean> {
  return view.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return false;
    const proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!set) return false;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`) as Promise<boolean>;
}

/** Choose an option of a React-controlled select, the way a person's choice reaches it: the native setter, then a change event. */
export async function setSelect(view: BrowserWindow, testId: string, value: string): Promise<boolean> {
  return view.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
    if (!set) return false;
    set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === ${JSON.stringify(value)};
  })()`) as Promise<boolean>;
}

/** The views of the icon rail, by the names in its test ids (`nav-<name>`). */
export type RailName = "home" | "conversation" | "novel" | "comic" | "video" | "note" | "whiteboard" | "mindmap" | "draft" | "roughcut" | "downloads";

/**
 * One icon of the rail, clicked as a person clicks it: the sidebar then lists that view. An icon that does not fit the window's height (or that was taken
 * out of the rail) is behind "…", where a click goes to the view as well.
 */
export async function railTo(view: BrowserWindow, name: RailName, timeoutMs = 6000): Promise<boolean> {
  if (!(await pointerClick(view, `nav-${name}`, Math.min(timeoutMs, 1500)))) {
    if (!(await pointerClick(view, "rail-more", 1500))) return false;
    if (!(await pointerClick(view, `rail-more-${name}`, timeoutMs))) return false;
  }
  return waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="sidebar"][data-view="${name}"]')) || !${DRAWN}(document.querySelector('[data-testid="sidebar"]'))`, 3000);
}

/** The sidebar is drawn: docked, or brought as an overlay by its switch when the window is too narrow for it (a click on the rail alone leaves a folded sidebar folded). */
export async function ensureSidebar(view: BrowserWindow, timeoutMs = 4000): Promise<boolean> {
  const drawn = `${DRAWN}(${PICK}("sidebar"))`;
  if (await waitUntil(view, drawn, 800)) return true;
  await clickTestId(view, "shell-sidebar-toggle", 1500);
  return waitUntil(view, drawn, timeoutMs);
}

/**
 * An entry or a row of the sidebar of one view, reached the way a person reaches it: the view's icon on the rail, the sidebar (shown if it was folded),
 * then the click. The click waits until the sidebar is the one of that view, so an entry of the view left behind is never the one that is pressed.
 */
export async function viaSidebar(view: BrowserWindow, name: RailName, testId: string, timeoutMs = 6000): Promise<boolean> {
  if (!(await railTo(view, name, timeoutMs))) return false;
  if (!(await ensureSidebar(view, timeoutMs))) return false;
  if (!(await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="sidebar"][data-view="${name}"]'))`, timeoutMs))) return false;
  return clickTestId(view, testId, timeoutMs);
}

/** The library's overview in a tab (the home's "资料库" entry). */
export async function openLibrary(view: BrowserWindow, timeoutMs = 8000): Promise<boolean> {
  if (!(await viaSidebar(view, "home", "sidebar-entry-library", timeoutMs))) return false;
  return waitDrawn(view, "page-library", timeoutMs);
}

/** The projects page in a tab (the home's "项目" entry). */
export async function openProjectsPage(view: BrowserWindow, timeoutMs = 8000): Promise<boolean> {
  if (!(await viaSidebar(view, "home", "sidebar-entry-projects", timeoutMs))) return false;
  return waitDrawn(view, "page-projects", timeoutMs);
}

/** The records of the notes (or of the conversations) in a tab: the manage entry of that view's sidebar. */
export async function openRecords(view: BrowserWindow, type: "note" | "conversation" = "note", timeoutMs = 8000): Promise<boolean> {
  if (!(await viaSidebar(view, type, "sidebar-manage", timeoutMs))) return false;
  return waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="records-tab"][data-type="${type}"]'))`, timeoutMs);
}

/** The window's search box, brought up with the global shortcut as a person does; true once its input is drawn. */
export async function openSearchBox(view: BrowserWindow, timeoutMs = 4000): Promise<boolean> {
  await pressChord(view, "K", ["control"]);
  return waitDrawn(view, "search-input", timeoutMs);
}

/** Close the search box with Esc; true once it is gone. */
export async function closeSearchBox(view: BrowserWindow, timeoutMs = 3000): Promise<boolean> {
  await pressKey(view, "Escape");
  return waitUntil(view, `!document.querySelector('[data-testid="search-box"]')`, timeoutMs);
}

/**
 * The shelf of one medium, reached the way a person reaches it: the home's library entry (a library tab at its overview), then "all" on the medium's
 * section. Library tabs already open are closed first so the page holds one shelf, and readers too (see `closeTabs`).
 */
export async function openShelf(view: BrowserWindow, kind: ShelfKind, timeoutMs = 8000, closing: readonly string[] = ["library", "reader"]): Promise<boolean> {
  await closeTabs(view, closing);
  if (!(await viaSidebar(view, "home", "sidebar-entry-library", timeoutMs))) return false;
  if (!(await waitDrawn(view, "page-library", timeoutMs))) return false;
  if (!(await clickTestId(view, `section-all-${kind}`, timeoutMs))) return false;
  return waitDrawn(view, `shelf-${kind}`, timeoutMs);
}

export type ShelfKind = "novel" | "comic" | "video";

/**
 * A work is opened from its card: the card shows the work's own page, and "read" / "watch" there opens the reader in a tab of its own. Every sample goes
 * through the medium's shelf first and then through the card, the way a person does.
 */
export async function openFromShelf(view: BrowserWindow, kind: ShelfKind, resourceId: string, timeoutMs = 6000, closing: readonly string[] = ["library", "reader"]): Promise<boolean> {
  if (!(await openShelf(view, kind, timeoutMs, closing))) return false;
  // A shelf of one medium draws only the rows in view (a virtual grid): a card further down is not in the page until the grid is scrolled to it,
  // as a person scrolls to find it.
  await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    let wrapped = false;
    const tick = () => {
      if (document.querySelector('[data-testid="open-${resourceId}"]')) return resolve(true);
      const grid = document.querySelector('[data-testid="shelf-grid"]');
      // The grid comes back where it was left, so the way down ends with one jump back to the top.
      if (grid && grid.scrollTop + grid.clientHeight < grid.scrollHeight - 1) grid.scrollTop += Math.max(100, grid.clientHeight / 2);
      else if (grid && !wrapped) { wrapped = true; grid.scrollTop = 0; }
      if (Date.now() - started > ${timeoutMs}) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  })`);
  if (!(await clickTestId(view, `open-${resourceId}`, timeoutMs))) return false;
  if (!(await waitForTestId(view, "page-work", "data-present", null, timeoutMs))) return false;
  return clickTestId(view, "work-read", timeoutMs);
}

/** Select a range of text nodes' content in the page, as a drag would, and tell the page the selection changed. */
export async function selectText(view: BrowserWindow, selector: string, start: number, end: number): Promise<{ ms: number; quote: string }> {
  return view.webContents.executeJavaScript(`(() => {
    const body = document.querySelector(${JSON.stringify(selector)});
    if (!body || !body.firstChild) return { ms: -1, quote: "" };
    const started = performance.now();
    const range = document.createRange();
    range.setStart(body.firstChild, ${start});
    range.setEnd(body.firstChild, ${end});
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return { ms: performance.now() - started, quote: range.toString() };
  })()`) as Promise<{ ms: number; quote: string }>;
}

/** The visible window size, the way the page sees it (the layout is checked at wide, narrow and short sizes). */
export async function viewport(view: BrowserWindow): Promise<{ innerWidth: number; innerHeight: number; devicePixelRatio: number }> {
  return view.webContents.executeJavaScript(`({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio })`) as Promise<{ innerWidth: number; innerHeight: number; devicePixelRatio: number }>;
}

/** Whether the browser would draw an element: it exists, and neither it nor an ancestor is `display: none` or `visibility: hidden` (a tab out of sight is the second). */
export const DRAWN = `((el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")`;

/** Wait until the element with this test id is drawn. */
export async function waitDrawn(view: BrowserWindow, testId: string, timeoutMs = 8000): Promise<boolean> {
  return waitUntil(view, `${DRAWN}(${PICK}(${JSON.stringify(testId)}))`, timeoutMs);
}

export type TabFact = { id: string; kind: string; title: string; focused: boolean; active: boolean };

/** The tab chips of the context in front, in the order of the strips (column by column). */
export async function tabsOf(view: BrowserWindow): Promise<TabFact[]> {
  return view.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('[data-testid="context-host"][data-active="true"]');
    return host ? [...host.querySelectorAll('[data-testid="tab"]')].map((chip) => ({
      id: chip.getAttribute("data-tab") ?? "",
      kind: chip.getAttribute("data-kind") ?? "",
      title: chip.querySelector(".tab-title")?.textContent ?? "",
      focused: chip.getAttribute("data-focused") === "true",
      active: chip.getAttribute("data-active") === "true",
    })) : [];
  })()`) as Promise<TabFact[]>;
}

/**
 * Close the tabs of a context with the button on each chip, as a person does, until none of the kinds is left. A reader that is out of sight is still
 * in the page, so a walk that looks things up by test id closes the tabs it is not about first.
 */
export async function closeTabs(view: BrowserWindow, kinds: readonly string[] | "all" = "all"): Promise<number> {
  return view.webContents.executeJavaScript(`new Promise((resolve) => {
    const kinds = ${JSON.stringify(kinds)};
    const started = Date.now();
    let closed = 0;
    const tick = () => {
      const host = document.querySelector('[data-testid="context-host"][data-active="true"]');
      const chips = host ? [...host.querySelectorAll('[data-testid="tab"]')].filter((chip) => kinds === "all" || kinds.includes(chip.getAttribute("data-kind"))) : [];
      if (chips.length === 0 || Date.now() - started > 8000) return resolve(closed);
      const button = chips[0].querySelector('[data-testid="tab-close"]');
      if (button) { button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); closed += 1; }
      setTimeout(tick, 80);
    };
    tick();
  })`) as Promise<number>;
}

/**
 * Bring a tab to the front by clicking its chip with the real pointer (the strip takes the press, not a dispatched click). The chip is found by id, kind or part
 * of its title; the answer is true once the tab is the focused one.
 */
export async function showTab(view: BrowserWindow, match: { id?: string; kind?: string; title?: string }): Promise<boolean> {
  const found = await view.webContents.executeJavaScript(`(() => {
    const want = ${JSON.stringify(match)};
    const host = document.querySelector('[data-testid="context-host"][data-active="true"]');
    const chip = host && [...host.querySelectorAll('[data-testid="tab"]')].find((item) => (!want.id || item.getAttribute("data-tab") === want.id) && (!want.kind || item.getAttribute("data-kind") === want.kind) && (!want.title || (item.querySelector(".tab-title")?.textContent ?? "").includes(want.title)));
    if (!chip) return null;
    const box = chip.getBoundingClientRect();
    return { id: chip.getAttribute("data-tab"), x: Math.round(box.left + Math.min(box.width / 2, 40)), y: Math.round(box.top + box.height / 2) };
  })()`) as { id: string; x: number; y: number } | null;
  if (!found) return false;
  view.webContents.sendInputEvent({ type: "mouseMove", x: found.x, y: found.y });
  view.webContents.sendInputEvent({ type: "mouseDown", x: found.x, y: found.y, button: "left", clickCount: 1 });
  view.webContents.sendInputEvent({ type: "mouseUp", x: found.x, y: found.y, button: "left", clickCount: 1 });
  return waitUntil(view, `document.querySelector('[data-testid="tab"][data-tab="${found.id}"]')?.getAttribute("data-focused") === "true"`, 3000);
}

/** A key with modifiers, sent as the keyboard sends it (trusted); the chord is held for a moment so the page sees it down and then up. */
export async function pressChord(view: BrowserWindow, keyCode: string, modifiers: readonly ("control" | "shift" | "alt")[] = [], heldMs = 40): Promise<void> {
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers: [...modifiers] } as never);
  await sleep(heldMs);
  view.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers: [...modifiers] } as never);
}
