import { defineConfig } from '@playwright/test'
process.env.MINDME_TEST_MIGRATION_TOKEN ??= `${Date.now() + 3600000}.local-export-test-only`
export default defineConfig({
  outputDir: 'test-results/cloud',
  testDir: './tests/e2e',
  testMatch: /(?:cloud|migration-source)\.spec\.ts/,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:8791',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && wrangler dev --port 8791 --env preview --var ENVIRONMENT:development --var DEV_AUTH:true --var MIGRATION_EXPORT_TOKEN:${process.env.MINDME_TEST_MIGRATION_TOKEN} --var SESSION_SECRET:local-integration-test-secret-more-than-32-characters --persist-to .wrangler/e2e-${Date.now()}`,
    url: 'http://localhost:8791/api/health',
    reuseExistingServer: false,
    timeout: 120000,
  },
})
