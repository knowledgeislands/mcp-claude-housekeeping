import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    fileParallelism: false,
    // No env seeding needed: config is loaded explicitly via loadConfig() and
    // passed into calls, so nothing reads process.env at import time. Tests
    // build their own Config/AuditConfig (or call loadConfig with an explicit
    // env object) and define their own tmpdir fixture roots.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Generated typed client — auto-produced by the mcporter codegen script.
        'src/generated/**',
        // Server entry point and tool registration aggregators are pure wiring
        // (every line is `server.registerTool(...)`); their behaviour is
        // exercised by `bun run server:mcp:inspect` and the smoke test in CI.
        'src/mcp-server/index.ts',
        'src/tools/**/index.ts',
        // Pure data: annotation presets are referenced only from tool
        // registration sites (which are themselves excluded).
        'src/utils/annotations.ts'
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
