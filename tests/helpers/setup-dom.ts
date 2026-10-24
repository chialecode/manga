// Runs before every test file. In a DOM test, `waitFor` and `findBy*` wait up to 5 s instead of 1 s: a full-suite run keeps
// many workers busy, and a render that takes 1.2 s there is slow, not wrong. A test that needs a shorter wait passes its own timeout.
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/dom");
  configure({ asyncUtilTimeout: 5000 });
}

// jsdom has no layout engine and no ResizeObserver. The message list (use-stick-to-bottom) needs one to exist; a test that cares about
// resizing installs its own with `vi.stubGlobal` and restores this one afterwards.
if (typeof window !== "undefined" && typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } };
}

// jsdom 30 hides every element with a `popover` attribute (its user-agent rule is `[popover]:not(:popover-open):not(dialog[open])`, and its cascade goes by
// specificity) but has no Popover API to open one, so a menu that asks for the top layer would be invisible to role queries. The rule below out-ranks
// it. The top layer itself is drawn by the browser and checked in the packaged window.
if (typeof document !== "undefined") {
  const style = document.createElement("style");
  style.textContent = "html body [popover][popover][popover][popover] { display: block; }";
  document.head.append(style);
}
