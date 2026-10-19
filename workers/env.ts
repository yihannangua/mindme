import type { MigrationConfig } from './api/migration'
export interface Env extends MigrationConfig {
  ASSETS: Fetcher
  SPACE: DurableObjectNamespace
  GOOGLE_CLIENT_ID?: string
  ALLOWED_GOOGLE_EMAIL?: string
  ALLOWED_GOOGLE_SUB?: string
  SESSION_SECRET?: string
  ENVIRONMENT?: string
  DEV_AUTH?: string
}
