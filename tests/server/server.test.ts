import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createMindmeServer } from '../../server/app'
import { configFromEnv } from '../../server/config'
import { ServerDatabase } from '../../server/database'
import { PersonalSpace } from '../../server/space'
import { PasskeyService } from '../../server/passkeys'
import { signSession } from '../../workers/auth/session'
import { applyChanges } from '../../src/domain/operations'
import { execute } from '../../src/domain/commands'
import { makeNode } from '../../src/domain/model'
import { emptySpace } from '../../src/domain/types'
import { operation, seed, first, ctx } from '../helpers'
import { APP_VERSION } from '../../src/version'
const secret = 'server-test-secret-longer-than-thirty-two-characters'
const cleanup: (() => Promise<unknown>)[] = []
function responseCookies(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  return (
    headers.getSetCookie?.() ??
    response.headers.get('set-cookie')?.split(/, (?=[^;]+=)/) ??
    []
  ).map((cookie) => cookie.split(';', 1)[0])
}
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mindme-server-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const staticDir = join(dir, 'dist')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><html>测试前端</html>')
  await writeFile(join(staticDir, 'sw.js'), '/* 测试缓存 */')
  const config = configFromEnv({
    NODE_ENV: 'development',
    DEV_AUTH: 'true',
    SESSION_SECRET: secret,
    PUBLIC_ORIGIN: 'http://127.0.0.1:3180',
    DATABASE_PATH: join(dir, 'mindme.sqlite'),
    STATIC_DIR: staticDir,
    PORT: '0',
  })
  const app = createMindmeServer(config, {
    verifyIdentity: async (credential) => {
      if (credential !== 'test') throw new Error('拒绝账号')
      return 'other-subject'
    },
  })
  await new Promise<void>((resolve) => app.http.listen(0, '127.0.0.1', resolve))
  const address = app.http.address()
  if (!address || typeof address === 'string') throw new Error('未取得监听地址')
  config.origin = `http://127.0.0.1:${address.port}`
  cleanup.push(() => app.close())
  const request = (path: string, init?: RequestInit) => fetch(config.origin + path, init)
  const login = async () => {
    const response = await request('/auth/dev-login', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    const [cookie] = responseCookies(response)
    const info = (await (await request('/auth/session', { headers: { cookie } })).json()) as {
      csrf: string
    }
    return { cookie, csrf: info.csrf }
  }
  return { app, config, dir, request, login }
}
describe('独立 Node 后端协议与安全', () => {
  it('迁移目标未导入完整空间前禁止登录与同步，健康与就绪分别报告', async () => {
    const { config, request } = await fixture()
    config.migrationRequired = true
    const health = await request('/api/health')
    expect(health.status).toBe(200)
    expect((await health.json()).migrationReady).toBe(false)
    expect((await request('/api/ready')).status).toBe(503)
    expect((await request('/auth/session')).status).toBe(503)
    expect((await request('/api/sync', { method: 'POST', body: '{}' })).status).toBe(503)
  })

  it('静态页面/健康/未授权/CSRF/生产开发入口边界', async () => {
    const { request, login, config } = await fixture()
    const health = await (await request('/api/health')).json()
    expect(health.backend).toBe('node-sqlite')
    expect(health.version).toBe(APP_VERSION)
    const page = await request('/deep/page')
    expect(await page.text()).toContain('测试前端')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect((await request('/assets/missing.js')).status).toBe(404)
    expect((await request('/api/sync', { method: 'POST', body: '{}' })).status).toBe(401)
    const { cookie, csrf } = await login()
    expect(
      (
        await request('/api/sync', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request('/api/sync', {
          method: 'POST',
          headers: {
            cookie,
            'content-type': 'application/json',
            origin: 'https://evil.example',
            'X-CSRF-Token': csrf,
          },
          body: '{}',
        })
      ).status,
    ).toBe(403)
    config.ENVIRONMENT = 'production'
    expect(
      (
        await request('/auth/dev-login', {
          method: 'POST',
          headers: { origin: config.origin, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404)
  })
  it('同步操作去重、增量与退出后旧会话拒绝', async () => {
    const { request, login, config } = await fixture(),
      { cookie, csrf } = await login()
    const headers = {
      cookie,
      origin: config.origin,
      'content-type': 'application/json',
      'X-CSRF-Token': csrf,
    }
    const space = seed(),
      op = operation(emptySpace(), space, 'A', Date.now())
    const sync = async (since: number, operations: unknown[]) => {
      const r = await request('/api/sync', {
        method: 'POST',
        headers,
        body: JSON.stringify({ schemaVersion: 1, since, operations }),
      })
      expect(r.status).toBe(200)
      return r.json()
    }
    const created = await sync(0, [op])
    expect(created.seq).toBe(1)
    expect(created.results[0].status).toBe('accepted')
    const repeated = await sync(1, [op])
    expect(repeated.seq).toBe(1)
    expect(repeated.space).toBeNull()
    const map = first(space),
      next = execute(
        space,
        map.id,
        { type: 'text', nodeId: map.rootId, text: 'Node 后端修改' },
        ctx(),
      ).space
    const modified = await sync(1, [operation(space, next, 'A', Date.now(), 2, 1)])
    expect(first(applyChanges(space, modified.changes, Date.now())).title).toBe('Node 后端修改')
    expect((await request('/auth/logout', { method: 'POST', headers })).status).toBe(200)
    expect(
      (
        await request('/api/sync', {
          method: 'POST',
          headers,
          body: JSON.stringify({ schemaVersion: 1, since: 2, operations: [] }),
        })
      ).status,
    ).toBe(401)
  })
  it('登录签发长期刷新会话，刷新轮换令牌并阻断重放', async () => {
    const { request, config } = await fixture()
    const login = await request('/auth/dev-login', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(login.status).toBe(200)
    const cookies = responseCookies(login)
    expect(cookies).toHaveLength(2)
    expect(cookies.some((cookie) => cookie.startsWith('mindme_session='))).toBe(true)
    expect(cookies.some((cookie) => cookie.startsWith('mindme_refresh='))).toBe(true)
    const access = cookies.find((cookie) => cookie.startsWith('mindme_session='))!
    const refresh = cookies.find((cookie) => cookie.startsWith('mindme_refresh='))!
    const refreshed = await request('/auth/refresh', {
      method: 'POST',
      headers: { origin: config.origin, cookie: refresh },
    })
    expect(refreshed.status).toBe(200)
    const rotated = responseCookies(refreshed)
    expect(rotated).toHaveLength(2)
    const nextAccess = rotated.find((cookie) => cookie.startsWith('mindme_session='))!
    const nextRefresh = rotated.find((cookie) => cookie.startsWith('mindme_refresh='))!
    expect((await request('/auth/session', { headers: { cookie: nextAccess } })).status).toBe(200)
    expect((await request('/auth/session', { headers: { cookie: access } })).status).toBe(200)
    const replay = await request('/auth/refresh', {
      method: 'POST',
      headers: { origin: config.origin, cookie: refresh },
    })
    expect(replay.status).toBe(401)
    expect(
      (
        await request('/auth/refresh', {
          method: 'POST',
          headers: { origin: config.origin, cookie: nextRefresh },
        })
      ).status,
    ).toBe(401)
  })
  it('退出登录会撤销刷新会话并清理两类 Cookie', async () => {
    const { request, config } = await fixture()
    const login = await request('/auth/dev-login', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: '{}',
    })
    const cookies = responseCookies(login)
    const access = cookies.find((cookie) => cookie.startsWith('mindme_session='))!
    const refresh = cookies.find((cookie) => cookie.startsWith('mindme_refresh='))!
    const session = (await (
      await request('/auth/session', { headers: { cookie: access } })
    ).json()) as {
      csrf: string
    }
    const logout = await request('/auth/logout', {
      method: 'POST',
      headers: {
        origin: config.origin,
        cookie: `${access}; ${refresh}`,
        'X-CSRF-Token': session.csrf,
      },
    })
    expect(logout.status).toBe(200)
    expect(responseCookies(logout)).toEqual(
      expect.arrayContaining(['mindme_session=', 'mindme_refresh=']),
    )
    expect(
      (
        await request('/auth/refresh', {
          method: 'POST',
          headers: { origin: config.origin, cookie: refresh },
        })
      ).status,
    ).toBe(401)
  })
  it('真实 WebSocket 通知与跨源升级拒绝', async () => {
    const { request, login, config } = await fixture(),
      { cookie, csrf } = await login()
    const socket = new WebSocket(config.origin.replace('http:', 'ws:') + '/api/ws', {
      origin: config.origin,
      headers: { cookie },
    })
    await once(socket, 'open')
    const message = once(socket, 'message')
    const response = await request('/api/sync', {
      method: 'POST',
      headers: {
        cookie,
        origin: config.origin,
        'content-type': 'application/json',
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({
        schemaVersion: 1,
        since: 0,
        operations: [operation(emptySpace(), seed(), 'A', Date.now())],
      }),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(String((await message)[0])).type).toBe('invalidate')
    socket.close()
    await once(socket, 'close')
    const denied = new WebSocket(config.origin.replace('http:', 'ws:') + '/api/ws', {
      origin: 'https://evil.example',
      headers: { cookie },
    })
    const failed = await new Promise<number>((resolve) => {
      denied.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0)
        response.resume()
        denied.terminate()
      })
      denied.on('error', () => undefined)
    })
    expect(failed).toBe(403)
  })
  it('绑定原始身份后拒绝其他有效身份覆盖空间', async () => {
    const { request, login, config } = await fixture()
    await login()
    const response = await request('/auth/login', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'test' }),
    })
    expect(response.status).toBe(401)
  })
})
describe('完整空间迁移、重启与恢复', () => {
  it('导入保留修订/原 ID/历史/去重/会话，已有 outbox 可继续提交且禁止覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mindme-migration-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const source = new ServerDatabase(join(dir, 'source.sqlite')),
      sourceSpace = new PersonalSpace(source),
      config = { SESSION_SECRET: secret },
      signed = await signSession('original-google-sub', config)
    sourceSpace.register(signed.session)
    const space = seed(),
      initial = operation(emptySpace(), space, 'A', Date.now())
    sourceSpace.sync(0, [initial], Date.now())
    sourceSpace.runJobs(Date.now() + 300001)
    const baseline = source.export().state,
      before = baseline.space,
      map = first(before),
      next = execute(
        before,
        map.id,
        { type: 'text', nodeId: map.rootId, text: '离线待提交文字' },
        ctx(),
      ).space,
      pending = operation(before, next, 'A', Date.now(), 2, baseline.seq)
    const snapshot = source.export(),
      target = new ServerDatabase(join(dir, 'target.sqlite'))
    target.import(snapshot)
    expect(first(snapshot.state.space).history).toHaveLength(1)
    expect(target.export()).toMatchObject({
      subject: snapshot.subject,
      state: snapshot.state,
      sessions: snapshot.sessions,
      events: snapshot.events,
    })
    expect(() => target.import(snapshot)).toThrow('拒绝覆盖')
    const targetSpace = new PersonalSpace(target)
    expect(targetSpace.validSession(signed.session)).toBe(true)
    const duplicate = targetSpace.sync(baseline.seq, [initial], Date.now())
    expect(duplicate.seq).toBe(baseline.seq)
    const accepted = targetSpace.sync(baseline.seq, [pending], Date.now())
    expect(accepted.results[0].status).toBe('accepted')
    target.close()
    const reopened = new ServerDatabase(join(dir, 'target.sqlite'))
    expect(first(reopened.export().state.space).title).toBe('离线待提交文字')
    expect(new PersonalSpace(reopened).validSession(signed.session)).toBe(true)
    source.close()
    reopened.close()
  })
  it('迁移文件损坏拒绝，SQLite 在线备份可恢复原空间', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mindme-backup-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const db = new ServerDatabase(join(dir, 'source.sqlite')),
      space = new PersonalSpace(db),
      signed = await signSession('original', { SESSION_SECRET: secret })
    space.register(signed.session)
    space.sync(0, [operation(emptySpace(), seed(), 'A', Date.now())], Date.now())
    await db.backup(join(dir, 'backup.sqlite'))
    const restored = new ServerDatabase(join(dir, 'backup.sqlite'))
    expect(restored.export().state).toEqual(db.export().state)
    const target = new ServerDatabase(join(dir, 'empty.sqlite')),
      broken = db.export()
    broken.state.space.maps[first(broken.state.space).id].rootId = 'missing'
    expect(() => target.import(broken)).toThrow()
    expect(target.export().state.seq).toBe(0)
    db.close()
    restored.close()
    target.close()
  })
  it('重启补执行五分钟历史与三十天回收站任务，最多保留十个版本', async () => {
    const db = new ServerDatabase(':memory:'),
      server = new PersonalSpace(db),
      signed = await signSession('original', { SESSION_SECRET: secret })
    server.register(signed.session)
    const now = Date.now(),
      space = seed()
    server.sync(0, [operation(emptySpace(), space, 'A', now)], now)
    server.runJobs(now + 300001)
    expect(first(db.export().state.space).history).toHaveLength(1)
    const before = db.export().state.space,
      map = first(before),
      deleted = execute(before, map.id, { type: 'trash' }, ctx(now + 400000)).space
    server.sync(
      db.export().state.seq,
      [operation(before, deleted, 'A', now + 400000, 2, db.export().state.seq)],
      now + 400000,
    )
    server.runJobs(now + 400000 + 30 * 86400000)
    expect(Object.keys(db.export().state.space.maps)).toHaveLength(0)
    expect(db.export().state.tombstones[map.id]).toBeDefined()
    db.close()
  })
  it('大图单节点编辑不再重写整图，空闲轮询零写入', async () => {
    const db = new ServerDatabase(':memory:'),
      server = new PersonalSpace(db),
      space = seed(),
      map = first(space)
    for (let i = 0; i < 3993; i++)
      map.nodes[`node-${i}`] = makeNode(`node-${i}`, map.rootId, '大图节点', i)
    const now = Date.now()
    server.sync(0, [operation(emptySpace(), space, 'A', now)], now)
    const written = () =>
      (db.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
    const before = written()
    server.sync(1, [], now)
    expect(written()).toBe(before)
    const next = execute(
      space,
      map.id,
      { type: 'text', nodeId: 'node-42', text: '只改一个节点' },
      ctx(now + 10),
    ).space
    server.sync(1, [operation(space, next, 'A', now + 10, 2, 1)], now + 10)
    expect(written() - before).toBeLessThanOrEqual(12)
    db.close()
  })
  it('生产环境缺少身份配置或 HTTP 来源时拒绝启动', () => {
    expect(() =>
      configFromEnv({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'http://localhost',
        SESSION_SECRET: secret,
      }),
    ).toThrow('HTTPS')
    expect(() =>
      configFromEnv({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://mindme.example',
        SESSION_SECRET: secret,
      }),
    ).toThrow('Google')
  })

  it('生产环境可只配置 Passkey，不再要求 Google OAuth', () => {
    expect(() =>
      configFromEnv({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://mindme.example',
        SESSION_SECRET: secret,
        AUTH_MODE: 'passkey',
      }),
    ).not.toThrow()
  })

  it('Passkey 首次设置仅在已迁移空间提供一次性挑战，不暴露 Google 配置', async () => {
    const { app, config, request } = await fixture()
    config.authMode = 'passkey'
    app.database.writeMeta('subject', 'legacy-google-subject')
    app.database.writeMeta('migrationExportedAt', String(Date.now()))
    const token = new PasskeyService(app.database, config.origin).createSetupToken()
    const session = (await (await request('/auth/session')).json()) as {
      authMode: string
      configured: boolean
      passkeyReady: boolean
      setupAvailable: boolean
      googleClientId?: string
    }
    expect(session).toMatchObject({
      authMode: 'passkey',
      configured: true,
      passkeyReady: false,
      setupAvailable: true,
    })
    expect(session.googleClientId).toBeUndefined()
    const options = await request('/auth/passkey/register/options', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: token }),
    })
    expect(options.status).toBe(200)
    const registration = (await options.json()) as {
      flowId: string
      options: { challenge: string }
    }
    expect(registration.flowId).toBeTruthy()
    expect(registration.options.challenge).toBeTruthy()
    const missingToken = await request('/auth/passkey/register/options', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(missingToken.status).toBe(401)
  })

  it('迁移保护模式仅在空库显式完成全新初始化后开放 Passkey 设置，不开放同步匿名访问', async () => {
    const { app, config, request } = await fixture()
    config.authMode = 'passkey'
    config.migrationRequired = true
    expect((await request('/api/ready')).status).toBe(503)
    const token = new PasskeyService(app.database, config.origin).createFreshAccountSetupToken()
    expect((await request('/api/ready')).status).toBe(200)
    const session = (await (await request('/auth/session')).json()) as {
      configured: boolean
      setupAvailable: boolean
      passkeyReady: boolean
    }
    expect(session).toMatchObject({ configured: true, setupAvailable: true, passkeyReady: false })
    expect(token).toBeTruthy()
    const sync = await request('/api/sync', {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, since: 0, operations: [] }),
    })
    expect(sync.status).toBe(401)
  })
})
