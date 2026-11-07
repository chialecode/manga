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
  /** Frames the fake decoder has presented, as the element's playback-quality counter reports them. */
  decoded: number;
  dropped: number;
};

/**
 * jsdom has no media pipeline: no play, pause, seek or duration. This gives every media element a small state of its own
 * and the events a page waits for. A test drives it with `loaded`, `advance`, `frame` and `fail`.
 */
export function installMediaElement() {
  const states = new WeakMap<HTMLMediaElement, FakeMedia>();
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const stateOf = (element: HTMLMediaElement): FakeMedia => {
    let state = states.get(element);
    if (!state) {
      state = { duration: Number.NaN, time: 0, paused: true, ended: false, rate: 1, volume: 1, muted: false, buffered: 0, frames: new Map(), error: null, seeks: [], played: 0, decoded: 0, dropped: 0 };
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
  define("getVideoPlaybackQuality", { value(this: HTMLMediaElement) { const state = stateOf(this); return { totalVideoFrames: state.decoded, droppedVideoFrames: state.dropped, corruptedVideoFrames: 0, creationTime: 0, totalFrameDelay: 0 }; } });
  define("cancelVideoFrameCallback", { value(this: HTMLMediaElement, handle: number) { stateOf(this).frames.delete(handle); } });

  return {
    state: stateOf,
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
    /** The decoder presented `count` more frames. */
    decode(element: HTMLMediaElement, count: number) {
      stateOf(element).decoded += count;
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
    },
  };
}

/**
 * jsdom lays nothing out: every element is 0 by 0 and a video has no picture size. This gives the subtitle layer a frame of its own and the video a
 * picture size, as the player gets them from a real window and file, so the layer can work out where its zones are.
 */
export function installPicture(size: { frame: { w: number; h: number }; video: { w: number; h: number } }) {
  const html = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const high = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const wide = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoWidth");
  const tall = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoHeight");
  const state = { ...size };
  const isLayer = (node: Element) => node.classList.contains("subtitle-layer");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return isLayer(this) ? state.frame.w : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return isLayer(this) ? state.frame.h : 0; } });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get() { return state.video.w; } });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get() { return state.video.h; } });
  const put = (target: object, name: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name);
  };
  return {
    /** The window or the video changed size. */
    set(next: Partial<typeof size>) { Object.assign(state, next); window.dispatchEvent(new Event("resize")); },
    restore() {
      put(HTMLElement.prototype, "clientWidth", html);
      put(HTMLElement.prototype, "clientHeight", high);
      put(HTMLVideoElement.prototype, "videoWidth", wide);
      put(HTMLVideoElement.prototype, "videoHeight", tall);
    },
  };
}

/**
 * jsdom draws nothing: a canvas has no context and cannot encode, a video has no size or frame and an image no natural size. This gives the page a
 * 2D context that records what was drawn, an encoder that returns the four bytes every PNG starts with, and the sizes of a decoded video and images,
 * so the code that turns what is on screen into a picture can run. What it cannot show is how the pixels look; that is checked in the packaged app.
 */
export function installCapture(options: { video?: { w: number; h: number } | null; image?: { w: number; h: number } | null } = {}) {
  const video = options.video === undefined ? { w: 1280, h: 720 } : options.video;
  const image = options.image === undefined ? { w: 800, h: 1200 } : options.image;
  const draws: Array<{ args: unknown[] }> = [];
  const canvases: Array<{ width: number; height: number }> = [];
  /** The text drawn by `fillText` and `strokeText`, with the font in force and the size of the canvas it went on. */
  const texts: Array<{ op: "fill" | "stroke"; text: string; x: number; y: number; font: string; fillStyle: string; width: number; height: number }> = [];
  const original = {
    getContext: HTMLCanvasElement.prototype.getContext,
    toBlob: HTMLCanvasElement.prototype.toBlob,
    ready: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "readyState"),
    wide: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoWidth"),
    tall: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "videoHeight"),
    naturalWidth: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalWidth"),
    naturalHeight: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "naturalHeight"),
  };
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    canvases.push(this);
    const canvas = this as HTMLCanvasElement & { __ink?: boolean };
    // A context that only records: what was drawn where, with which font, and (through `__ink`) whether a canvas has anything painted on it.
    const context: Record<string, unknown> = {
      drawImage: (...args: unknown[]) => {
        draws.push({ args });
        if ((args[0] as { __ink?: boolean } | undefined)?.__ink) canvas.__ink = true;
      },
      fillText: (text: string, x: number, y: number) => { texts.push({ op: "fill", text, x, y, font: String(context.font), fillStyle: String(context.fillStyle), width: canvas.width, height: canvas.height }); canvas.__ink = true; },
      strokeText: (text: string, x: number, y: number) => { texts.push({ op: "stroke", text, x, y, font: String(context.font), fillStyle: String(context.strokeStyle), width: canvas.width, height: canvas.height }); canvas.__ink = true; },
      measureText: (text: string) => ({ width: Array.from(text).length * Number(/(\d+(?:\.\d+)?)px/.exec(String(context.font))?.[1] ?? 10) * 0.5 }),
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(canvas.__ink ? w * h * 4 : 4);
        if (canvas.__ink) data[3] = 255;
        return { data, width: w, height: h };
      },
      save() {}, restore() {}, globalAlpha: 1, font: "", textAlign: "", textBaseline: "", lineJoin: "", lineWidth: 0, strokeStyle: "", fillStyle: "",
      shadowColor: "", shadowBlur: 0, shadowOffsetY: 0, canvas,
    };
    return context as unknown as CanvasRenderingContext2D;
  } as never;
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) { callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })); } as never;
  if (video) {
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get() { return 4; } });
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get() { return video.w; } });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get() { return video.h; } });
  }
  if (image) {
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", { configurable: true, get() { return image.w; } });
    Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", { configurable: true, get() { return image.h; } });
  }
  const put = (target: object, name: string, descriptor: PropertyDescriptor | undefined) => {
    if (descriptor) Object.defineProperty(target, name, descriptor); else Reflect.deleteProperty(target, name);
  };
  return {
    draws,
    canvases,
    texts,
    restore() {
      HTMLCanvasElement.prototype.getContext = original.getContext;
      HTMLCanvasElement.prototype.toBlob = original.toBlob;
      put(HTMLMediaElement.prototype, "readyState", original.ready);
      put(HTMLVideoElement.prototype, "videoWidth", original.wide);
      put(HTMLVideoElement.prototype, "videoHeight", original.tall);
      put(HTMLImageElement.prototype, "naturalWidth", original.naturalWidth);
      put(HTMLImageElement.prototype, "naturalHeight", original.naturalHeight);
    },
  };
}
