import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'tests/electron-stub.ts')
    }
  },
  test: {
    environment: 'node',
    globals: true,
    pool: 'threads',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts']
  }
})
