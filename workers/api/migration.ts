export interface MigrationConfig {
  MIGRATION_EXPORT_TOKEN?: string
  MIGRATION_READ_ONLY?: string
}
export function migrationAuthorized(request: Request, env: MigrationConfig, now = Date.now()) {
  const expected = env.MIGRATION_EXPORT_TOKEN,
    supplied = request.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!expected || !supplied || supplied.length > 512 || supplied.length !== expected.length)
    return false
  const expires = Number(expected.split(/[.:]/)[0])
  if (!Number.isSafeInteger(expires) || expires <= now) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++)
    mismatch |= expected.charCodeAt(i) ^ supplied.charCodeAt(i)
  return mismatch === 0
}
