import { mergeConfig } from 'vite'
import shared from './vite.shared.config.js'

export default mergeConfig(shared, {
  build: {
    lib: {
      entry: 'src/main/index.ts',
      fileName: () => 'main.cjs',
      formats: ['cjs'],
    },
  },
})
