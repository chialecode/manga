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
