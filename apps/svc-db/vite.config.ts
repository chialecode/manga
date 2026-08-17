import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'src/index.ts',
    outDir: '../desktop/.vite/build',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      external: ['better-sqlite3'],
      output: { entryFileNames: 'svc-db.cjs', format: 'cjs' },
    },
  },
})
