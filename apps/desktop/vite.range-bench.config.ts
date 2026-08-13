import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: '.vite/build',
    ssr: 'src/smoke/range-bench.ts',
    rollupOptions: { output: { entryFileNames: 'range-bench.cjs', format: 'cjs' } },
  },
})
