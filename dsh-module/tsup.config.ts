import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // DSH host provides these at runtime (peerDependencies)
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-compaction',
    '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
  ],
})
