import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergeConfig } from 'vite'
import shared from './vite.shared.config.js'

const desktopRoot = fileURLToPath(new URL('.', import.meta.url))

export default mergeConfig(shared, {
  root: resolve(desktopRoot, 'src/renderer'),
  build: {
    outDir: resolve(desktopRoot, '.vite/renderer/main_window'),
    emptyOutDir: true,
  },
})
