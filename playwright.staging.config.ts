import { defineConfig } from '@playwright/test'

const stagingUrl = (process.env.STAGING_URL || '').trim()
if (!stagingUrl) {
  throw new Error(
    [
      'STAGING_URL is not set -- refusing to guess a target.',
      'Example:',
      '  STAGING_URL=https://feat-core-cli-runner-test-alfred.princicol.co.uk STAGING_TOKEN=... npm run test:staging-ui',
    ].join('\n'),
  )
}

const isSafeTarget =
  stagingUrl.includes('-test-') ||
  stagingUrl.includes('localhost') ||
  stagingUrl.includes('127.0.0.1') ||
  process.env.ALLOW_PROD_UI_TEST === '1'

if (!isSafeTarget) {
  throw new Error(
    `Refusing to run staging UI tests against non-staging URL "${stagingUrl}" without ALLOW_PROD_UI_TEST=1.`,
  )
}

export default defineConfig({
  testDir: './tests/staging-ui',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: stagingUrl,
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.CHROMIUM_BIN || undefined,
    },
  },
})
