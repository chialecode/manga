/** jsdom lacks a few browser APIs the readers use. Tests install just the ones they exercise. */

/** A pointer event that carries coordinates and an id, so a drag can be simulated. */
export function installPointerEvent(): void {
  const target = window as unknown as { PointerEvent?: unknown };
  if (target.PointerEvent) return;
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  target.PointerEvent = TestPointerEvent;
}

/** `matchMedia` answering "reduce" for the reduced-motion query only. */
export function installMatchMedia(options: { reducedMotion: boolean }): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: options.reducedMotion && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

export function removeMatchMedia(): void {
  Reflect.deleteProperty(window, "matchMedia");
}

// ---- media elements ---------------------------------------------------------

type FrameCallback = (now: number, metadata: { mediaTime: number }) => void;

export type FakeMedia = {
  duration: number;
  time: number;
  paused: boolean;
  ended: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  buffered: number;
  frames: Map<number, FrameCallback>;
  error: { code: number; message: string } | null;
  /** Every currentTime the page assigned, in order. */
  seeks: number[];
  played: number;
};

/**
 * jsdom has no media pipeline: no play, pause, seek or duration. This gives every media element a small state of its own
 * and the events a page waits for. A test drives it with `loaded`, `advance`, `frame` and `fail`.
 */
export function installMediaElement() {
  const states = new WeakMap<HTMLMediaElement, FakeMedia>();
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const stateOf = (element: HTMLMediaElement): FakeMedia => {
    let state = states.get(element);
    if (!state) {
      state = { duration: Number.NaN, time: 0, paused: true, ended: false, rate: 1, volume: 1, muted: false, buffered: 0, frames: new Map(), error: null, seeks: [], played: 0 };
      states.set(element, state);
    }
    return state;
  };
  const define = (name: string, descriptor: PropertyDescriptor) => {
    saved.set(name, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name));
    Object.defineProperty(HTMLMediaElement.prototype, name, { configurable: true, ...descriptor });
  };
  const fire = (element: HTMLMediaElement, type: string) => element.dispatchEvent(new Event(type));

  define("duration", { get(this: HTMLMediaElement) { return stateOf(this).duration; } });
  define("readyState", { get(this: HTMLMediaElement) { return Number.isFinite(stateOf(this).duration) ? 1 : 0; } });
  define("paused", { get(this: HTMLMediaElement) { return stateOf(this).paused; } });
  define("ended", { get(this: HTMLMediaElement) { return stateOf(this).ended; } });
  define("seeking", { get() { return false; } });
  define("error", { get(this: HTMLMediaElement) { return stateOf(this).error; } });
  define("buffered", { get(this: HTMLMediaElement) { const end = stateOf(this).buffered; return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end }; } });
  define("currentTime", {
    get(this: HTMLMediaElement) { return stateOf(this).time; },
    set(this: HTMLMediaElement, value: number) {
      const state = stateOf(this);
      state.time = value;
      state.ended = false;
      state.seeks.push(value);
      fire(this, "seeking");
      queueMicrotask(() => { fire(this, "seeked"); fire(this, "timeupdate"); });
    },
  });
  for (const name of ["playbackRate", "volume", "muted"] as const) {
    const key = name === "playbackRate" ? "rate" : name;
    define(name, {
      get(this: HTMLMediaElement) { return stateOf(this)[key]; },
      set(this: HTMLMediaElement, value: never) { (stateOf(this) as Record<string, unknown>)[key] = value; },
    });
  }
  define("play", {
    value(this: HTMLMediaElement) {
      const state = stateOf(this);
      state.paused = false;
      state.ended = false;
      state.played += 1;
      fire(this, "play");
      fire(this, "playing");
      return Promise.resolve();
    },
  });
  define("pause", {
    value(this: HTMLMediaElement) {
      const state = stateOf(this);
      if (state.paused) return;
      state.paused = true;
      fire(this, "pause");
    },
  });
  define("load", { value() { /* nothing to load */ } });
  define("requestVideoFrameCallback", {
    value(this: HTMLMediaElement, callback: FrameCallback) {
      const state = stateOf(this);
      const handle = state.frames.size + 1 + Math.floor(Math.random() * 1e6);
      state.frames.set(handle, callback);
      return handle;
    },
  });
  define("cancelVideoFrameCallback", { value(this: HTMLMediaElement, handle: number) { stateOf(this).frames.delete(handle); } });

  const tracks = new WeakMap<HTMLMediaElement, { mode: string; cues: Array<{ startTime: number; endTime: number; text: string }>; addCue: (cue: { startTime: number; endTime: number; text: string }) => void; removeCue: (cue: unknown) => void }>();
  define("addTextTrack", {
    value(this: HTMLMediaElement) {
      const track = { mode: "disabled", cues: [] as Array<{ startTime: number; endTime: number; text: string }>, addCue(cue: { startTime: number; endTime: number; text: string }) { track.cues.push(cue); }, removeCue(cue: unknown) { track.cues = track.cues.filter((item) => item !== cue); } };
      tracks.set(this, track);
      return track;
    },
  });
  const cueScope = globalThis as unknown as { VTTCue?: unknown };
  const hadCue = cueScope.VTTCue;
  cueScope.VTTCue = class { constructor(public startTime: number, public endTime: number, public text: string) {} };
  void proto;

  return {
    state: stateOf,
    textTrack: (element: HTMLMediaElement) => tracks.get(element) ?? null,
    /** The file's metadata arrived: the element knows its length. */
    loaded(element: HTMLMediaElement, duration: number) {
      stateOf(element).duration = duration;
      fire(element, "loadedmetadata");
      fire(element, "durationchange");
    },
    /** Time passes while the video plays (or is just moved, when paused). */
    advance(element: HTMLMediaElement, seconds: number) {
      const state = stateOf(element);
      state.time = Math.min(state.duration, state.time + seconds);
      fire(element, "timeupdate");
    },
    finish(element: HTMLMediaElement) {
      const state = stateOf(element);
      state.time = state.duration;
      state.paused = true;
      state.ended = true;
      fire(element, "pause");
      fire(element, "ended");
    },
    /** The player presented a frame whose media time is `seconds`. */
    frame(element: HTMLMediaElement, seconds: number) {
      const callbacks = [...stateOf(element).frames.values()];
      stateOf(element).frames.clear();
      for (const callback of callbacks) callback(0, { mediaTime: seconds });
    },
    fail(element: HTMLMediaElement, code: number, message = "") {
      stateOf(element).error = { code, message };
      fire(element, "error");
    },
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, name, descriptor);
        else Reflect.deleteProperty(HTMLMediaElement.prototype, name);
      }
      if (hadCue === undefined) Reflect.deleteProperty(cueScope, "VTTCue"); else cueScope.VTTCue = hadCue;
    },
  };
}
