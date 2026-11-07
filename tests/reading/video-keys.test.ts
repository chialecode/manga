/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createArrowKeys, type ArrowSide, type Scheduler } from "../../apps/desktop/src/renderer/readers/video-keys.ts";

/** A clock the test turns by hand: a timer runs when `advance` reaches it. */
function manualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const scheduler: Scheduler = {
    set: (run, ms) => { const id = nextId++; timers.set(id, { at: now + ms, run }); return id; },
    clear: (id) => { timers.delete(id); },
  };
  return {
    scheduler,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
    },
    pending: () => timers.size,
  };
}

function setup(holdMs = 300) {
  const clock = manualClock();
  const events: string[] = [];
  const keys = createArrowKeys({
    tap: (side: ArrowSide) => events.push(`tap ${side}`),
    holdStart: (side: ArrowSide) => events.push(`hold ${side}`),
    holdEnd: (side: ArrowSide) => events.push(`release ${side}`),
  }, { holdMs, scheduler: clock.scheduler });
  return { keys, clock, events };
}

describe("AT-83 arrow keys: a tap is a step, a hold lasts until the key is let go", () => {
  it("steps once, when the key goes up before the hold time, and not while it is down", () => {
    const { keys, clock, events } = setup();
    keys.down(1);
    clock.advance(120);
    expect(events).toEqual([]);
    keys.up(1);
    expect(events).toEqual(["tap 1"]);
    // The pending hold is gone: the time passing later starts nothing.
    clock.advance(1000);
    expect(events).toEqual(["tap 1"]);
    expect(clock.pending()).toBe(0);
    keys.down(-1);
    keys.up(-1);
    expect(events).toEqual(["tap 1", "tap -1"]);
  });

  it("starts a hold once the key has been down for the hold time, ends it when the key goes up, and never steps for it", () => {
    const { keys, clock, events } = setup();
    keys.down(1);
    clock.advance(299);
    expect(events).toEqual([]);
    clock.advance(1);
    expect(events).toEqual(["hold 1"]);
    expect(keys.active()).toEqual({ side: 1, held: true });
    clock.advance(5000);
    keys.up(1);
    expect(events).toEqual(["hold 1", "release 1"]);
    expect(keys.active()).toBeNull();
  });

  it("holds the left arrow the same way (the rewind) on its own side", () => {
    const { keys, clock, events } = setup();
    keys.down(-1);
    clock.advance(400);
    keys.up(-1);
    expect(events).toEqual(["hold -1", "release -1"]);
  });

  it("ignores the system's key repeat: it neither steps again nor restarts the hold", () => {
    const { keys, clock, events } = setup();
    keys.down(1);
    for (let count = 0; count < 12; count += 1) { clock.advance(30); keys.down(1, true); }
    expect(events).toEqual(["hold 1"]);
    keys.up(1);
    expect(events).toEqual(["hold 1", "release 1"]);
  });

  it("ends what is down when the other arrow goes down: a quick press steps, a hold is released, and the new key starts its own", () => {
    const { keys, clock, events } = setup();
    keys.down(1);
    clock.advance(100);
    keys.down(-1);
    expect(events).toEqual(["tap 1"]);
    clock.advance(400);
    keys.down(1);
    expect(events).toEqual(["tap 1", "hold -1", "release -1"]);
    keys.up(-1);
    expect(events).toEqual(["tap 1", "hold -1", "release -1"]);
    keys.up(1);
    expect(events).toEqual(["tap 1", "hold -1", "release -1", "tap 1"]);
  });

  it("lets go of a hold, without any step, when the window loses focus or the player goes away", () => {
    const { keys, clock, events } = setup();
    keys.down(1);
    clock.advance(500);
    keys.release();
    expect(events).toEqual(["hold 1", "release 1"]);
    keys.down(-1);
    clock.advance(100);
    keys.release();
    expect(events).toEqual(["hold 1", "release 1"]);
    expect(clock.pending()).toBe(0);
    // A key-up that arrives after the release finds nothing to end.
    keys.up(-1);
    expect(events).toEqual(["hold 1", "release 1"]);
  });

  it("works with the real timers of the page by default", () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const keys = createArrowKeys({ tap: () => events.push("tap"), holdStart: () => events.push("hold"), holdEnd: () => events.push("end") });
      keys.down(1);
      vi.advanceTimersByTime(299);
      expect(events).toEqual([]);
      vi.advanceTimersByTime(2);
      expect(events).toEqual(["hold"]);
      keys.up(1);
      expect(events).toEqual(["hold", "end"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AT-135 holding → speeds up every time, even after the player missed a key", () => {
  it("takes a fresh press of a key still down as a lost key-up: the old hold ends, the new press holds on its own, and no step is added", () => {
    const { keys, clock, events } = setup();
    keys.down(1);
    clock.advance(500);
    // The key-up never came; the person presses → again and holds it.
    keys.down(1);
    expect(events).toEqual(["hold 1", "release 1"]);
    clock.advance(300);
    expect(events).toEqual(["hold 1", "release 1", "hold 1"]);
    keys.up(1);
    expect(events).toEqual(["hold 1", "release 1", "hold 1", "release 1"]);
    // A lost key-up after a tap: the pending step is dropped, not made twice.
    keys.down(1);
    clock.advance(100);
    keys.down(1);
    keys.up(1);
    expect(events.slice(4)).toEqual(["tap 1"]);
  });

  it("starts the hold at once when only the system's repeats arrive (the press went elsewhere), with no step", () => {
    const { keys, clock, events } = setup();
    keys.down(1, true);
    expect(events).toEqual(["hold 1"]);
    for (let count = 0; count < 10; count += 1) { clock.advance(33); keys.down(1, true); }
    expect(events).toEqual(["hold 1"]);
    keys.up(1);
    expect(events).toEqual(["hold 1", "release 1"]);
    expect(clock.pending()).toBe(0);
    // ← the same way: the rewind starts and ends.
    keys.down(-1, true);
    keys.up(-1);
    expect(events).toEqual(["hold 1", "release 1", "hold -1", "release -1"]);
  });

  it("keeps a short tap one step: a press and its key-up, repeated, never step twice", () => {
    const { keys, clock, events } = setup();
    for (let count = 0; count < 25; count += 1) { keys.down(1); clock.advance(80); keys.up(1); clock.advance(80); }
    expect(events).toEqual(Array.from({ length: 25 }, () => "tap 1"));
  });

  it("ends the hold when the window loses focus in the middle of it, and the next hold starts again", () => {
    const { keys, clock, events } = setup();
    keys.down(1);
    clock.advance(400);
    keys.release();
    keys.down(1, true);
    keys.up(1);
    expect(events).toEqual(["hold 1", "release 1", "hold 1", "release 1"]);
  });
});
