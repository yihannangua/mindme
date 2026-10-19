import { resolve } from 'node:path'
import type { AuthConfig } from '../workers/auth/session'
export interface ServerConfig extends AuthConfig {
  origin: string
  host: string
  port: number
  database: string
  staticDir: string
  development: boolean
  migrationRequired: boolean
  authMode: 'google' | 'passkey'
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const origin = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:3180')
  if (
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    !['http:', 'https:'].includes(origin.protocol)
  )
    throw new Error('PUBLIC_ORIGIN 必须是完整站点来源，不含路径和凭据')
  const development = env.NODE_ENV === 'development'
  if (!development && origin.protocol !== 'https:')
    throw new Error('生产 PUBLIC_ORIGIN 必须使用 HTTPS')
  const config: ServerConfig = {
    origin: origin.origin,
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3180),
    database: resolve(env.DATABASE_PATH ?? './data/mindme.sqlite'),
    staticDir: resolve(env.STATIC_DIR ?? './dist'),
    development,
    migrationRequired: env.MIGRATION_REQUIRED === 'true',
    authMode: env.AUTH_MODE === 'passkey' ? 'passkey' : 'google',
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    ALLOWED_GOOGLE_EMAIL: env.ALLOWED_GOOGLE_EMAIL,
    ALLOWED_GOOGLE_SUB: env.ALLOWED_GOOGLE_SUB || undefined,
    SESSION_SECRET: env.SESSION_SECRET,
    ENVIRONMENT: development ? 'development' : 'production',
    DEV_AUTH: development ? env.DEV_AUTH : undefined,
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error('PORT 不合法')
  if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 32)
    throw new Error('SESSION_SECRET 必须至少 32 字符，迁移时保留原密钥')
  if (
    !development &&
    config.authMode === 'google' &&
    (!config.GOOGLE_CLIENT_ID || !config.ALLOWED_GOOGLE_EMAIL)
  )
    throw new Error('生产环境必须配置 Google 客户端及准入邮箱')
  return config
}
