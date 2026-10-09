import { register } from "node:module";
// Loads the stand-in for the WebRTC library in a plain Node process (used by tests and tools that run the engine without bundling it).
register(new URL("./stub-hooks.mjs", import.meta.url));
