const stub = new URL("./webrtc-polyfill.mjs", import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === "webrtc-polyfill") return { url: stub, shortCircuit: true };
  return next(specifier, context);
}
