import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose'
export interface AuthConfig {
  GOOGLE_CLIENT_ID?: string
  ALLOWED_GOOGLE_EMAIL?: string
  ALLOWED_GOOGLE_SUB?: string
  SESSION_SECRET?: string
  ENVIRONMENT?: string
  DEV_AUTH?: string
}
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const key = (env: AuthConfig) => new TextEncoder().encode(env.SESSION_SECRET ?? '')
export const configured = (env: AuthConfig) =>
  !!(
    env.GOOGLE_CLIENT_ID &&
    env.ALLOWED_GOOGLE_EMAIL &&
    env.SESSION_SECRET &&
    env.SESSION_SECRET.length >= 32
  )
export function devAllowed(request: Request, env: AuthConfig) {
  return (
    env.ENVIRONMENT === 'development' &&
    env.DEV_AUTH === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
  )
}
export async function verifyGoogle(
  credential: string,
  env: AuthConfig,
  keys: JWTVerifyGetKey = googleKeys,
) {
  if (!configured(env)) throw new Error('云端认证尚未配置')
  const { payload } = await jwtVerify(credential, keys, {
    algorithms: ['RS256'],
    audience: env.GOOGLE_CLIENT_ID,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    requiredClaims: ['exp', 'iat', 'sub', 'email', 'email_verified'],
    clockTolerance: 5,
  })
  if (
    payload.email_verified !== true ||
    typeof payload.email !== 'string' ||
    payload.email.toLowerCase() !== env.ALLOWED_GOOGLE_EMAIL!.toLowerCase() ||
    !payload.sub ||
    (env.ALLOWED_GOOGLE_SUB && payload.sub !== env.ALLOWED_GOOGLE_SUB)
  )
    throw new Error('此账号没有访问权限')
  return payload.sub
}
export interface Session {
  sub: string
  sid: string
  csrf: string
  exp: number
}
export interface RefreshToken {
  token: string
  hash: string
}
export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600
export const REFRESH_MAX_SECONDS = 90 * 24 * 3600
function base64url(bytes: Uint8Array) {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
export async function createRefreshToken(): Promise<RefreshToken> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = base64url(bytes),
    hash = await hashRefreshToken(token)
  return { token, hash }
}
export async function hashRefreshToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return base64url(new Uint8Array(digest))
}
export async function signSession(subject: string, env: AuthConfig, now = Date.now()) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('会话密钥尚未配置')
  const session = {
    sub: subject,
    sid: crypto.randomUUID(),
    csrf: crypto.randomUUID(),
    exp: Math.floor(now / 1000) + ACCESS_TTL_SECONDS,
  }
  const token = await new SignJWT({ sid: session.sid, csrf: session.csrf })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer('mindme')
    .setAudience('mindme-session')
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(session.exp)
    .sign(key(env))
  return { session, token }
}
export async function readSession(request: Request, env: AuthConfig): Promise<Session | null> {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('mindme_session='))
    ?.slice('mindme_session='.length)
  if (!token || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return null
  try {
    const { payload } = await jwtVerify(token, key(env), {
      algorithms: ['HS256'],
      issuer: 'mindme',
      audience: 'mindme-session',
      requiredClaims: ['exp', 'iat', 'sub'],
    })
    if (
      !payload.sub ||
      typeof payload.sid !== 'string' ||
      typeof payload.csrf !== 'string' ||
      !payload.exp
    )
      return null
    return { sub: payload.sub, sid: payload.sid, csrf: payload.csrf, exp: payload.exp }
  } catch {
    return null
  }
}
export function sameOrigin(request: Request) {
  return request.headers.get('origin') === new URL(request.url).origin
}
export function readRefreshToken(request: Request) {
  return request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('mindme_refresh='))
    ?.slice('mindme_refresh='.length)
}
export function validCsrf(request: Request, session: Session) {
  return sameOrigin(request) && request.headers.get('X-CSRF-Token') === session.csrf
}
export const sessionCookie = (token: string, secure = true, clear = false) =>
  `mindme_session=${clear ? '' : token}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Max-Age=${clear ? 0 : ACCESS_TTL_SECONDS}`
export const refreshCookie = (token: string, secure = true, clear = false) =>
  `mindme_refresh=${clear ? '' : token}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Max-Age=${clear ? 0 : REFRESH_TTL_SECONDS}`
