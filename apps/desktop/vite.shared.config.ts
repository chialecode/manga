import { defineConfig } from 'vite'

const channel = process.env.BUILD_CHANNEL === 'stable' ? 'stable' : 'dev'
const startupBenchmark = process.env.BUILD_STARTUP_BENCHMARK === '1'

export default defineConfig({
  define: { __BUILD_CHANNEL__: JSON.stringify(channel), __STARTUP_BENCHMARK__: JSON.stringify(startupBenchmark) },
  build: { sourcemap: true },
})
