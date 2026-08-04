import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/__tests__/**/*.test.ts'],
    // 关键: mock koishi,避免触发 logger 副作用
    setupFiles: ['./src/__tests__/setup.ts'],
  },
  resolve: {
    alias: {
      koishi: resolve(__dirname, 'src/__tests__/__mocks__/koishi.ts'),
    },
  },
})
