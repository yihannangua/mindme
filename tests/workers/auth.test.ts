import { describe, expect, it } from 'vitest'
import {
  configured,
  devAllowed,
  readSession,
  refreshCookie,
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  sameOrigin,
  sessionCookie,
  signSession,
  validCsrf,
} from '../../workers/auth/session'
import { readJson } from '../../workers/api/http'
import type { Env } from '../../workers/env'
const env = { SESSION_SECRET: 'a-secure-test-secret-with-more-than-32-characters' } as Env
const req = (token: string) =>
  new Request('https://mindme.example/api/sync', { headers: { cookie: `mindme_session=${token}` } })
describe('认证与请求边界', () => {
  it('签发短期会话并拒绝篡改、过期和错误密钥', async () => {
    const signed = await signSession('subject-one', env)
    expect(await readSession(req(signed.token), env)).toMatchObject({
      sub: 'subject-one',
      sid: signed.session.sid,
    })
    expect(await readSession(req(signed.token.slice(0, -5) + 'abcde'), env)).toBeNull()
    expect(
      await readSession(req((await signSession('subject-one', env, 1000)).token), env),
    ).toBeNull()
    expect(
      await readSession(req(signed.token), {
        ...env,
        SESSION_SECRET: 'different-secret-with-more-than-32-characters',
      }),
    ).toBeNull()
  })
  it('写请求必须同时同源且持有 CSRF 凭据', async () => {
    const { session } = await signSession('subject', env)
    const make = (origin: string, csrf: string) =>
      new Request('https://mindme.example/api/sync', {
        method: 'POST',
        headers: { origin, 'X-CSRF-Token': csrf },
      })
    expect(validCsrf(make('https://mindme.example', session.csrf), session)).toBe(true)
    expect(validCsrf(make('https://evil.example', session.csrf), session)).toBe(false)
    expect(validCsrf(make('https://mindme.example', 'bad'), session)).toBe(false)
    expect(sameOrigin(new Request('https://mindme.example'))).toBe(false)
  })
  it('生产 Cookie 安全属性齐全，开发入口不能在公网启用', () => {
    expect(sessionCookie('token')).toContain('HttpOnly; Secure; SameSite=Strict')
    expect(sessionCookie('token', false)).toContain(`Max-Age=${ACCESS_TTL_SECONDS}`)
    expect(refreshCookie('token')).toContain('Path=/; HttpOnly; Secure; SameSite=Strict')
    expect(refreshCookie('token', false)).toContain(`Max-Age=${REFRESH_TTL_SECONDS}`)
    expect(refreshCookie('', false, true)).not.toContain('Secure')
    expect(configured(env)).toBe(false)
    const development = { ...env, ENVIRONMENT: 'development', DEV_AUTH: 'true' }
    expect(devAllowed(new Request('http://localhost:8787/auth/dev-login'), development)).toBe(true)
    expect(devAllowed(new Request('https://public.example/auth/dev-login'), development)).toBe(
      false,
    )
    expect(
      devAllowed(new Request('http://localhost:8787/auth/dev-login'), {
        ...development,
        ENVIRONMENT: 'production',
      }),
    ).toBe(false)
  })
  it('拒绝非 JSON、超限和损坏请求，避免无限读取', async () => {
    await expect(
      readJson(new Request('https://a', { method: 'POST', body: '{}' }), 100),
    ).rejects.toThrow('application/json')
    await expect(
      readJson(
        new Request('https://a', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        }),
        100,
      ),
    ).rejects.toThrow('损坏')
    await expect(
      readJson(
        new Request('https://a', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'a'.repeat(100) }),
        }),
        10,
      ),
    ).rejects.toThrow('容量')
  })
})

import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { verifyGoogle } from '../../workers/auth/session'
it('Google 签名与账号准入分别校验 issuer、audience、过期、已验证邮箱和稳定 sub', async () => {
  const pair = await generateKeyPair('RS256'),
    jwk = await exportJWK(pair.publicKey),
    keys = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', kid: 'local-test' }] })
  const config = {
    ...env,
    GOOGLE_CLIENT_ID: 'client-id',
    ALLOWED_GOOGLE_EMAIL: 'owner@example.com',
    ALLOWED_GOOGLE_SUB: 'stable-subject',
  }
  const token = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      sub: 'stable-subject',
      email: 'owner@example.com',
      email_verified: true,
      iss: 'https://accounts.google.com',
      aud: 'client-id',
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'local-test' })
      .sign(pair.privateKey)
  await expect(verifyGoogle(await token(), config, keys)).resolves.toBe('stable-subject')
  for (const invalid of [
    { iss: 'https://evil.example' },
    { aud: 'another-client' },
    { exp: 1000 },
    { email_verified: false },
    { email: 'other@example.com' },
    { sub: 'different-subject' },
  ])
    await expect(verifyGoogle(await token(invalid), config, keys)).rejects.toThrow()
})

import { migrationAuthorized } from '../../workers/api/migration'
it('完整空间导出仅接受精确匹配且未过期的短期令牌', () => {
  const token = '2000:temporary-random-export-capability',
    config = { MIGRATION_EXPORT_TOKEN: token }
  const request = (value: string) =>
    new Request('https://mindme.example/api/migration/export', {
      method: 'POST',
      headers: { authorization: `Bearer ${value}` },
    })
  expect(migrationAuthorized(request(token), config, 1000)).toBe(true)
  expect(migrationAuthorized(request(token), config, 2000)).toBe(false)
  expect(migrationAuthorized(request(token + 'x'), config, 1000)).toBe(false)
  expect(migrationAuthorized(request(token), {}, 1000)).toBe(false)
})
