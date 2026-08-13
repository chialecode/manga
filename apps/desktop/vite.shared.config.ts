import { defineConfig } from 'vite'

const channel = process.env.BUILD_CHANNEL === 'stable' ? 'stable' : 'dev'

export default defineConfig({
  define: { __BUILD_CHANNEL__: JSON.stringify(channel) },
  build: { sourcemap: true },
})
