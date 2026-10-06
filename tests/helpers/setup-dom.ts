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
