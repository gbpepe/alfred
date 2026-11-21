import { defineConfig } from 'vitest/config'

import baseConfig from './vitest.config.ts'

// Isolated Alfred Core test configuration:
// Collects Alfred Core `src/__tests__/alfred-*.test.ts` suites (excluding legacy
// Python/tmux helper tests), which strictly use `:memory:` SQLite and `tmpdir()`
// so they never mutate live `store/` or `.env` state. The global `vitest.config.ts`
// live-install gate remains completely intact for `npm test`.
const baseSetupFiles = baseConfig.test?.setupFiles ?? []
const inheritedSetupFiles = Array.isArray(baseSetupFiles) ? baseSetupFiles : [baseSetupFiles]
const baseExcludes = baseConfig.test?.exclude ?? []

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['src/__tests__/alfred-*.test.ts'],
    exclude: [
      ...baseExcludes,
      'src/__tests__/alfred-api-*.test.ts',
      'src/__tests__/alfred-commands-hook.test.ts',
      'src/__tests__/alfred-restart-button-force.test.ts',
    ],
    setupFiles: inheritedSetupFiles.filter(
      (file) => !String(file).includes('assert-not-live-install'),
    ),
  },
})
