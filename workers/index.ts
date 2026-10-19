import type { Env } from './env'
import {
  configured,
  devAllowed,
  readSession,
  sameOrigin,
  sessionCookie,
  signSession,
  validCsrf,
  verifyGoogle,
  type Session,
} from './auth/session'
import { json, readJson, secureResponse } from './api/http'
import { migrationAuthorized } from './api/migration'
import { APP_VERSION } from '../src/version'
import { storageFailure } from './api/failures'
export { SpaceObject } from './space-object/SpaceObject'
const object = (env: Env) => env.SPACE.get(env.SPACE.idFromName('personal-space-v1'))
const forward = async (request: Request, env: Env, session: Session, path?: string) => {
  const headers = new Headers(request.headers)
  headers.delete('cookie')
  headers.delete('authorization')
  headers.set('X-Auth-Sub', session.sub)
  headers.set('X-Session-Id', session.sid)
  let body: string | undefined
  if (request.method === 'POST' && (path ?? new URL(request.url).pathname) === '/api/sync') {
    try {
      body = JSON.stringify(await readJson(request, 24 * 1024 * 1024))
    } catch {
      return json({ error: '同步格式不合法或请求过大' }, 400)
    }
  }
  return object(env).fetch(
    new Request(path ? new URL(path, request.url) : request.url, {
      method: request.method,
      headers,
      body,
    }),
  )
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname
  if (path === '/api/health' && request.method === 'GET')
    return json({ ok: true, version: APP_VERSION, schemaVersion: 1 })
  if (!path.startsWith('/auth/') && !path.startsWith('/api/')) return env.ASSETS.fetch(request)
  if (path === '/api/migration/export') {
    if (request.method !== 'POST' || !migrationAuthorized(request, env))
      return json({ error: '迁移接口不可用' }, 404)
    return object(env).fetch(
      new Request('https://space/internal/migration-export', {
        method: 'POST',
        headers: { 'X-Migration-Approved': '1' },
      }),
    )
  }
  if (
    env.MIGRATION_READ_ONLY === 'true' &&
    ['/auth/login', '/auth/dev-login', '/auth/logout'].includes(path)
  )
    return json(
      { error: '空间正在迁移，请稍后重试；本地数据保留', code: 'MIGRATION_IN_PROGRESS' },
      503,
      { 'Retry-After': '60' },
    )
  const session = await readSession(request, env)
  if (path === '/auth/session' && request.method === 'GET') {
    const valid = session
      ? (await forward(new Request(new URL('/internal/check-session', url)), env, session)).ok
      : false
    return json({
      authenticated: valid,
      configured: configured(env) || devAllowed(request, env),
      googleClientId: env.GOOGLE_CLIENT_ID,
      subject: valid ? session!.sub : undefined,
      csrf: valid ? session!.csrf : undefined,
      serverTime: Date.now(),
    })
  }
  if ((path === '/auth/login' || path === '/auth/dev-login') && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: '登录来源不被允许' }, 403)
    if (path === '/auth/dev-login' && !devAllowed(request, env))
      return json({ error: '接口不存在' }, 404)
    try {
      const body = (await readJson(request, 16000)) as { credential?: string }
      const subject =
        path === '/auth/dev-login'
          ? 'local-test-subject'
          : await verifyGoogle(typeof body?.credential === 'string' ? body.credential : '', env)
      const signed = await signSession(subject, env)
      const registered = await object(env).fetch(
        new Request('https://space/internal/register-session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signed.session),
        }),
      )
      if (!registered.ok) return json({ error: 'Google 身份与已绑定空间不一致' }, 403)
      return json({ ok: true }, 200, {
        'set-cookie': sessionCookie(signed.token, !devAllowed(request, env)),
      })
    } catch (error) {
      const quota = storageFailure(error)
      if (quota) return quota
      return json({ error: '登录失败：身份无效、账号无权限或服务尚未配置' }, 401)
    }
  }
  if (path === '/auth/logout' && request.method === 'POST') {
    if (!session || !validCsrf(request, session)) return json({ error: '会话或请求校验失败' }, 403)
    const response = await forward(request, env, session, '/internal/logout')
    if (!response.ok) return response
    return json({ ok: true }, 200, {
      'set-cookie': sessionCookie('', !devAllowed(request, env), true),
    })
  }
  if (!session) return json({ error: '请先登录' }, 401)
  if (request.method !== 'GET' && !validCsrf(request, session))
    return json({ error: '请求来源或 CSRF 校验失败' }, 403)
  if (path === '/api/ws' && (request.method !== 'GET' || !sameOrigin(request)))
    return json({ error: 'WebSocket 来源不被允许' }, 403)
  if (
    (path === '/api/sync' && request.method === 'POST') ||
    (path === '/api/ws' && request.method === 'GET')
  )
    return forward(request, env, session)
  return json({ error: '接口不存在' }, 404)
}
export default {
  async fetch(request: Request, env: Env) {
    try {
      return secureResponse(await route(request, env))
    } catch (error) {
      return secureResponse(
        storageFailure(error) ?? json({ error: '服务暂时不可用，请稍后重试' }, 503),
      )
    }
  },
} satisfies ExportedHandler<Env>
