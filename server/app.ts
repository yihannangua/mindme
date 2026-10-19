import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import {
  configured,
  devAllowed,
  readSession,
  sameOrigin,
  sessionCookie,
  refreshCookie,
  readRefreshToken,
  hashRefreshToken,
  createRefreshToken,
  REFRESH_MAX_SECONDS,
  REFRESH_TTL_SECONDS,
  signSession,
  validCsrf,
  verifyGoogle,
  type Session,
} from '../workers/auth/session'
import { json, readJson, secureResponse } from '../workers/api/http'
import type { Operation } from '../src/domain/types'
import type { ServerConfig } from './config'
import { ServerDatabase } from './database'
import { PasskeyService } from './passkeys'
import { PersonalSpace } from './space'
import { APP_VERSION } from '../src/version'
function cookieHeaders(cookies: string[]) {
  const headers = new Headers()
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return headers
}
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}
export function createMindmeServer(
  config: ServerConfig,
  options: { verifyIdentity?: (credential: string) => Promise<string> } = {},
) {
  const database = new ServerDatabase(config.database),
    space = new PersonalSpace(database),
    passkeys = new PasskeyService(database, config.origin),
    sockets = new Map<WebSocket, Session>()
  const ws = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  let closing = false
  const migrationReady = () =>
    !config.migrationRequired ||
    !!database.readMeta('migrationExportedAt') ||
    !!database.readMeta('freshStartAt')
  const broadcast = (seq: number) => {
    for (const [socket, session] of sockets) {
      if (!space.validSession(session)) socket.close(1008, '会话已失效')
      else if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: 'invalidate', seq }))
    }
  }
  space.onCommit = broadcast
  const verifyIdentity =
    options.verifyIdentity ?? ((credential: string) => verifyGoogle(credential, config))
  const issueAuth = async (subject: string, secure: boolean) => {
    const signed = await signSession(subject, config),
      refresh = await createRefreshToken(),
      now = Math.floor(Date.now() / 1000)
    space.register(signed.session)
    space.registerRefresh({
      hash: refresh.hash,
      familyId: crypto.randomUUID(),
      sub: subject,
      expiresAt: now + REFRESH_TTL_SECONDS,
      absoluteExpiresAt: now + REFRESH_MAX_SECONDS,
    })
    return [sessionCookie(signed.token, secure), refreshCookie(refresh.token, secure)]
  }
  async function staticAsset(pathname: string): Promise<Response> {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return json({ error: '路径格式错误' }, 400)
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return json({ error: '路径不合法' }, 400)
    let path = resolve(config.staticDir, '.' + decoded)
    if (path !== config.staticDir && !path.startsWith(config.staticDir + sep))
      return json({ error: '资源不存在' }, 404)
    try {
      if (!(await stat(path)).isFile()) throw new Error('目录')
    } catch {
      if (pathname.startsWith('/assets/') || extname(pathname))
        return json({ error: '资源不存在' }, 404)
      path = resolve(config.staticDir, 'index.html')
    }
    try {
      const content = await readFile(path)
      return new Response(content, {
        headers: {
          'content-type': types[extname(path)] ?? 'application/octet-stream',
          'cache-control': pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
      })
    } catch {
      return json({ error: '前端资源未构建，请先执行 npm run build' }, 503)
    }
  }
  async function route(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/health' && request.method === 'GET') {
      database.sql.exec('SELECT 1').toArray()
      return json(
        {
          ok: !closing,
          version: APP_VERSION,
          schemaVersion: 1,
          backend: 'node-sqlite',
          migrationReady: migrationReady(),
        },
        closing ? 503 : 200,
      )
    }
    if (pathname === '/api/ready' && request.method === 'GET')
      return json({ ready: migrationReady() && !closing }, migrationReady() && !closing ? 200 : 503)
    if ((pathname.startsWith('/auth/') || pathname.startsWith('/api/')) && !migrationReady())
      return json(
        {
          error: '目标空间等待完整数据迁移，暂不接受登录和修改；原浏览器数据请保留。',
          code: 'MIGRATION_REQUIRED',
        },
        503,
        { 'Retry-After': '60' },
      )
    if (!pathname.startsWith('/auth/') && !pathname.startsWith('/api/'))
      return ['GET', 'HEAD'].includes(request.method)
        ? staticAsset(pathname)
        : json({ error: '请求方法不支持' }, 405)
    const session = await readSession(request, config),
      valid = !!session && space.validSession(session)
    if (pathname === '/auth/session' && request.method === 'GET')
      return json({
        authenticated: valid,
        configured:
          config.authMode === 'passkey'
            ? migrationReady() && !!database.readMeta('subject')
            : configured(config) || devAllowed(request, config),
        authMode: config.authMode,
        passkeyReady:
          config.authMode === 'passkey' &&
          !!database.db.prepare('SELECT 1 FROM passkeys LIMIT 1').get(),
        setupAvailable:
          config.authMode === 'passkey' &&
          !!database.readMeta('passkeySetupTokenHash') &&
          Number(database.readMeta('passkeySetupTokenExpiresAt')) > Date.now(),
        googleClientId: config.authMode === 'google' ? config.GOOGLE_CLIENT_ID : undefined,
        subject: valid ? session!.sub : undefined,
        csrf: valid ? session!.csrf : undefined,
        serverTime: Date.now(),
      })
    if (config.authMode === 'passkey' && pathname.startsWith('/auth/passkey/')) {
      if (!sameOrigin(request)) return json({ error: '登录来源不被允许' }, 403)
      const body = (await readJson(request, 16000)) as Record<string, unknown>
      try {
        if (pathname === '/auth/passkey/login/options' && request.method === 'POST') {
          const result = await passkeys.authenticationOptions()
          return json(result)
        }
        if (pathname === '/auth/passkey/login/verify' && request.method === 'POST') {
          if (
            typeof body?.flowId !== 'string' ||
            !body.response ||
            typeof body.response !== 'object'
          )
            throw new Error('认证请求格式错误')
          const subject = await passkeys.verifyAuthentication(body.flowId, body.response as never)
          const cookies = await issueAuth(subject, !config.development)
          return json({ ok: true }, 200, cookieHeaders(cookies))
        }
        if (pathname === '/auth/passkey/register/options' && request.method === 'POST') {
          if (valid && session) {
            if (!validCsrf(request, session)) return json({ error: 'CSRF 校验失败' }, 403)
            return json(
              await passkeys.registrationOptions({
                sub: session.sub,
                setupToken: typeof body?.setupToken === 'string' ? body.setupToken : undefined,
              }),
            )
          }
          if (typeof body?.setupToken !== 'string') throw new Error('请输入服务器生成的设置令牌')
          return json(await passkeys.registrationOptions({ setupToken: body.setupToken }))
        }
        if (pathname === '/auth/passkey/register/verify' && request.method === 'POST') {
          if (
            typeof body?.flowId !== 'string' ||
            !body.response ||
            typeof body.response !== 'object'
          )
            throw new Error('认证请求格式错误')
          const setupToken = typeof body.setupToken === 'string' ? body.setupToken : undefined
          if (valid && session) {
            if (!validCsrf(request, session)) return json({ error: 'CSRF 校验失败' }, 403)
          }
          const result = await passkeys.verifyRegistration({
            flowId: body.flowId,
            response: body.response as never,
            sub: valid ? session?.sub : undefined,
            setupToken,
          })
          if (result.recoveryCodes) {
            const cookies = await issueAuth(result.sub, !config.development)
            return json(
              { ok: true, recoveryCodes: result.recoveryCodes },
              200,
              cookieHeaders(cookies),
            )
          }
          return json({ ok: true })
        }
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Passkey 操作失败' }, 401)
      }
      return json({ error: '接口不存在' }, 404)
    }
    if (
      config.authMode === 'passkey' &&
      pathname === '/auth/recovery/login' &&
      request.method === 'POST'
    ) {
      if (!sameOrigin(request)) return json({ error: '登录来源不被允许' }, 403)
      try {
        const body = (await readJson(request, 16000)) as { code?: unknown }
        if (typeof body?.code !== 'string') throw new Error('恢复码无效或已使用')
        const result = await passkeys.recover(body.code)
        const cookies = await issueAuth(result.sub, !config.development)
        return json({ ok: true }, 200, cookieHeaders(cookies))
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : '恢复登录失败' }, 401)
      }
    }
    if (
      (pathname === '/auth/dev-login' ||
        (pathname === '/auth/login' && config.authMode === 'google')) &&
      request.method === 'POST'
    ) {
      if (!sameOrigin(request)) return json({ error: '登录来源不被允许' }, 403)
      if (pathname === '/auth/dev-login' && !devAllowed(request, config))
        return json({ error: '接口不存在' }, 404)
      try {
        const body = (await readJson(request, 16000)) as { credential?: string }
        const subject =
          pathname === '/auth/dev-login'
            ? 'local-test-subject'
            : await verifyIdentity(typeof body?.credential === 'string' ? body.credential : '')
        const cookies = await issueAuth(subject, !devAllowed(request, config))
        return json({ ok: true }, 200, cookieHeaders(cookies))
      } catch {
        return json({ error: '登录失败：身份无效、账号无权限或空间身份不一致' }, 401)
      }
    }
    if (pathname === '/auth/refresh' && request.method === 'POST') {
      if (!sameOrigin(request)) return json({ error: '登录来源不被允许' }, 403)
      const oldToken = readRefreshToken(request)
      if (!oldToken)
        return json(
          { error: '刷新会话不存在' },
          401,
          cookieHeaders([
            sessionCookie('', !config.development, true),
            refreshCookie('', !config.development, true),
          ]),
        )
      const next = await createRefreshToken(),
        rotated = space.rotateRefresh(await hashRefreshToken(oldToken), next.hash, Date.now())
      if (!rotated)
        return json(
          { error: '刷新会话已失效，请重新登录' },
          401,
          cookieHeaders([
            sessionCookie('', !config.development, true),
            refreshCookie('', !config.development, true),
          ]),
        )
      const signed = await signSession(rotated.sub, config)
      space.register(signed.session)
      return json(
        { ok: true },
        200,
        cookieHeaders([
          sessionCookie(signed.token, !config.development),
          refreshCookie(next.token, !config.development),
        ]),
      )
    }
    if (!valid || !session) return json({ error: '请先登录' }, 401)
    if (request.method !== 'GET' && !validCsrf(request, session))
      return json({ error: '请求来源或 CSRF 校验失败' }, 403)
    if (pathname === '/auth/logout' && request.method === 'POST') {
      space.revoke(session)
      const refreshToken = readRefreshToken(request)
      if (refreshToken) space.revokeRefresh(await hashRefreshToken(refreshToken))
      else space.revokeAllRefresh(session.sub)
      for (const [socket, record] of sockets)
        if (record.sid === session.sid) socket.close(1008, '会话已退出')
      return json(
        { ok: true },
        200,
        cookieHeaders([
          sessionCookie('', !devAllowed(request, config), true),
          refreshCookie('', !devAllowed(request, config), true),
        ]),
      )
    }
    if (
      config.authMode === 'passkey' &&
      pathname === '/auth/recovery/rotate' &&
      request.method === 'POST'
    ) {
      const codes = await passkeys.rotateRecoveryCodes(session.sub)
      return json({ recoveryCodes: codes })
    }
    if (pathname === '/api/sync' && request.method === 'POST') {
      let body: { schemaVersion: number; since: number; operations: Operation[] }
      try {
        body = (await readJson(request, 24 * 1024 * 1024)) as typeof body
        if (
          !body ||
          body.schemaVersion !== 1 ||
          !Number.isSafeInteger(body.since) ||
          body.since < 0 ||
          !Array.isArray(body.operations) ||
          body.operations.length > 100
        )
          throw new Error('格式错误')
      } catch {
        return json({ error: '同步格式不合法或请求过大' }, 400)
      }
      return json({ ...space.sync(body.since, body.operations, Date.now()), subject: session.sub })
    }
    return json({ error: '接口不存在' }, 404)
  }
  async function requestFromNode(incoming: IncomingMessage) {
    const url = new URL(incoming.url ?? '/', config.origin)
    if (url.origin !== config.origin) throw new Error('请求路径不合法')
    const headers = new Headers()
    for (const [key, value] of Object.entries(incoming.headers))
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    const method = incoming.method ?? 'GET'
    if (['GET', 'HEAD'].includes(method)) return new Request(url, { method, headers })
    const max = url.pathname.startsWith('/auth/') ? 16000 : 24 * 1024 * 1024
    if (Number(headers.get('content-length')) > max) {
      incoming.resume()
      throw new RangeError('请求超过容量上限')
    }
    const parts: Buffer[] = []
    let length = 0
    for await (const part of incoming) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
      length += chunk.length
      if (length > max) throw new RangeError('请求超过容量上限')
      parts.push(chunk)
    }
    return new Request(url, { method, headers, body: Buffer.concat(parts) })
  }
  async function send(response: Response, outgoing: ServerResponse, head: boolean) {
    const secured = secureResponse(response)
    const headers: Record<string, string | string[]> = Object.fromEntries(secured.headers),
      cookies = secured.headers.getSetCookie?.()
    if (cookies?.length) headers['set-cookie'] = cookies
    outgoing.writeHead(secured.status, headers)
    if (head) outgoing.end()
    else outgoing.end(Buffer.from(await secured.arrayBuffer()))
  }
  const http = createServer(async (incoming, outgoing) => {
    try {
      const request = await requestFromNode(incoming)
      await send(await route(request), outgoing, incoming.method === 'HEAD')
    } catch (error) {
      console.error(
        JSON.stringify({
          event: '请求处理失败',
          kind: error instanceof Error ? error.name : '未知异常',
        }),
      )
      if (!outgoing.headersSent)
        await send(
          json(
            {
              error:
                error instanceof RangeError ? '请求超过容量上限' : '服务暂时不可用，请稍后重试',
            },
            error instanceof RangeError ? 413 : 503,
          ),
          outgoing,
          false,
        )
      else outgoing.end()
    }
  })
  http.requestTimeout = 30000
  http.headersTimeout = 15000
  http.on('upgrade', (incoming, socket, head) => {
    void (async () => {
      const request = await requestFromNode(incoming)
      if (
        !migrationReady() ||
        new URL(request.url).pathname !== '/api/ws' ||
        !sameOrigin(request)
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      const session = await readSession(request, config)
      if (!session || !space.validSession(session)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      ws.handleUpgrade(incoming, socket, head, (client) => {
        sockets.set(client, session)
        client.on('error', () => client.close())
        client.on('close', () => sockets.delete(client))
        client.on('message', () => {
          if (!space.validSession(session)) client.close(1008, '会话已失效')
          else client.send(JSON.stringify({ type: 'invalidate' }))
        })
      })
    })().catch(() => socket.destroy())
  })
  const jobs = setInterval(() => {
    try {
      if (migrationReady()) space.runJobs()
      for (const [socket, session] of sockets)
        if (!space.validSession(session)) socket.close(1008, '会话已过期')
    } catch {
      console.error(JSON.stringify({ event: '后台任务失败' }))
    }
  }, 15000)
  jobs.unref()
  // 启动即扫描持久任务，重启后补执行历史/回收站/会话到期清理。
  if (migrationReady()) space.runJobs()
  return {
    http,
    database,
    space,
    async close() {
      if (closing) return
      closing = true
      clearInterval(jobs)
      for (const client of sockets.keys()) client.close(1001, '服务维护')
      ws.close()
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      )
      database.close()
    },
  }
}
