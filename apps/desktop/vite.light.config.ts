import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

/**
 * Light open's main process (`light-main.cjs`, A-128): `@manga/app-core/light` and Electron. Only Electron and Node's own modules stay outside the
 * bundle; a native module such as the library database cannot be bundled, so importing one fails the build, and the package check
 * (`light-boundary`) looks for the forbidden modules in what comes out.
 */
export const lightMainBuild = {
  build: {
    emptyOutDir: false,
    lib: { entry: "src/main/light/main.ts", formats: ["cjs" as const], fileName: () => "light-main.cjs" },
    rollupOptions: { external: ["electron", ...nodeBuiltins], output: { inlineDynamicImports: true } },
    sourcemap: true,
    outDir: ".vite/build",
  },
};

export default defineConfig(lightMainBuild);
