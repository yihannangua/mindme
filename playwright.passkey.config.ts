import { defineConfig } from '@playwright/test'

process.env.MINDME_TEST_ORIGIN = 'http://localhost:8793'
const databasePath = '.wrangler/passkey-e2e.sqlite'
process.env.MINDME_TEST_DATABASE = databasePath

export default defineConfig({
  outputDir: 'test-results/passkey',
  testDir: './tests/e2e',
  testMatch: /passkey\.spec\.ts/,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.MINDME_TEST_ORIGIN,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `rm -f ${databasePath} ${databasePath}-wal ${databasePath}-shm && npm run build && npm run build:server && NODE_ENV=development DEV_AUTH=true AUTH_MODE=passkey MIGRATION_REQUIRED=true PUBLIC_ORIGIN=http://localhost:8793 HOST=127.0.0.1 PORT=8793 DATABASE_PATH=${databasePath} SESSION_SECRET=local-integration-test-secret-more-than-32-characters node dist-server/index.js`,
    url: 'http://localhost:8793/api/health',
    reuseExistingServer: false,
    timeout: 120000,
  },
})
