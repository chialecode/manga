import { mergeConfig } from 'vite'
import shared from './vite.shared.config.js'

export default mergeConfig(shared, {
  define: {
    MAIN_WINDOW_VITE_DEV_SERVER_URL: 'undefined',
    MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
  },
  build: {
    emptyOutDir: false,
    outDir: '.vite/build',
    ssr: 'src/smoke/rpc-main.ts',
    rollupOptions: {
      external: ['electron'],
      output: { entryFileNames: 'rpc-smoke.cjs', format: 'cjs' },
    },
  },
})
