import * as os from 'node:os'
import * as path from 'node:path'
import { defineConfig } from 'vitest/config'

const TEST_HOUSEKEEPING = path.join(os.tmpdir(), 'mcp-local-tests-housekeeping')

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    env: {
      MCP_CLAUDE_HOUSEKEEPING_PATH: TEST_HOUSEKEEPING
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Server entry points and tool registration aggregators are pure
        // wiring (every line is `server.registerTool(...)`); their behaviour
        // is exercised by `npm run inspect` and the smoke test in CI.
        'src/mcp-server/index.ts',
        'src/claude-code/tools.ts',
        'src/claude-desktop/tools.ts',
        'src/vscode/tools.ts',
        'src/shared/annotations.ts'
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100
      }
    }
  }
})
