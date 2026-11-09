import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

/**
 * The packaged main entry (`main.cjs`, A-128): Node and Electron only. It picks light open (`light-main.cjs`) or the full application
 * (`full-main.cjs`) by the command line and watches the first starts after an update (4.2). Nothing of `@manga/*` is in it.
 */
export const bootstrapBuild = {
  build: {
    emptyOutDir: false,
    lib: { entry: "src/main/bootstrap.ts", formats: ["cjs" as const], fileName: () => "main.cjs" },
    rollupOptions: { external: ["electron", ...nodeBuiltins], output: { inlineDynamicImports: true } },
    sourcemap: true,
    outDir: ".vite/build",
  },
};

export default defineConfig(bootstrapBuild);
