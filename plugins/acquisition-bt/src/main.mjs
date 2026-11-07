import { connect } from "./link.mjs";
import { BtEngine } from "./engine.mjs";

/* global PLUGIN_VERSION */
const version = typeof PLUGIN_VERSION === "string" ? PLUGIN_VERSION : "dev";

/**
 * The plugin's entry: the acquisition slot's methods over the host link. Everything the engine learns is sent as an `acq.*` event; the host decides
 * what to do with it. The engine keeps nothing about a job beyond the folder the host gave it, so the host can add the same job again after a stop or a crash.
 */
let engine = null;
connect({
  init: async ({ event }) => { engine = new BtEngine({ emit: event, version }); },
  stop: async () => { await engine?.shutdown(); },
  methods: {
    "engine.info": () => engine.info(),
    "engine.configure": (params) => engine.configure(params),
    "engine.limits": (params) => engine.setLimits(params),
    "engine.add": (params) => engine.add(params),
    "engine.select": (params) => engine.select(params),
    "engine.seed": (params) => engine.seed(params),
    "engine.remove": (params) => engine.remove(params),
    "engine.status": () => engine.status(),
  },
});
