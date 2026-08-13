import { mergeConfig } from 'vite'
import shared from './vite.shared.config.js'

export default mergeConfig(shared, {
  build: {
    rollupOptions: {
      output: { entryFileNames: 'preload.js' },
    },
  },
})
