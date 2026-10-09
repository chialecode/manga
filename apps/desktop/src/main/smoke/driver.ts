import type { BrowserWindow } from "electron";

/** Small helpers that drive the real renderer from the main process (packaged-window smoke only). */

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Click the element once it exists and is enabled; pages fill in after their data arrives, so a missing (or still disabled) element
 * is waited for briefly.
 */
export async function clickTestId(view: BrowserWindow, testId: string, timeoutMs = 4000): Promise<boolean> {
  return view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector('[data-testid="${testId}"]');
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
 * A real mouse click at the element's centre: unlike a dispatched event it is trusted and carries user activation, which
 * browser APIs such as `requestFullscreen()` insist on. The window must be shown and the element in view.
 */
export async function trustedClick(view: BrowserWindow, testId: string, timeoutMs = 4000): Promise<boolean> {
  const point = await view.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector('[data-testid="${testId}"]');
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
      const el = document.querySelector('[data-testid="${testId}"]');
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

/**
 * A work is opened from its card: the card shows the work's own page, and "read" / "watch" there opens the reader. Navigation always lands
 * on a shelf, so every sample goes through the rail first and then through the card, the way a person does.
 */
export async function openFromShelf(view: BrowserWindow, nav: string, resourceId: string, timeoutMs = 6000): Promise<boolean> {
  if (!(await clickTestId(view, nav, timeoutMs))) return false;
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
