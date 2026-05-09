import * as os from 'node:os'
import * as path from 'node:path'
import { defineConfig } from 'vitest/config'

const TEST_ROOT = path.join(os.tmpdir(), 'mcp-local-tests-root')
const TEST_HOUSEKEEPING = path.join(os.tmpdir(), 'mcp-local-tests-housekeeping')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    env: {
      ROOT_PATH: TEST_ROOT,
      HOUSEKEEPING_PATH: TEST_HOUSEKEEPING
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70
      }
    }
  }
})
