import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server'
import type { ServerDatabase } from './database'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const equalHash = (a: string, b: string) => {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}
const normalizeCode = (value: string) => value.toLowerCase().replace(/[^a-f0-9]/g, '')
const codeSet = () =>
  Array.from({ length: 10 }, () =>
    randomBytes(16)
      .toString('hex')
      .match(/.{1,4}/g)!
      .join('-'),
  )

type Flow = {
  flow_id: string
  kind: string
  challenge: string
  sub: string
  setup_token_hash: string | null
  expires_at: number
}
type StoredCredential = {
  credential_id: string
  public_key: string
  counter: number
  transports: string
  sub: string
}

export class PasskeyService {
  readonly rpID: string
  readonly rpName = 'Mindme'

  constructor(
    private readonly database: ServerDatabase,
    readonly origin: string,
  ) {
    this.rpID = new URL(origin).hostname
  }

  createSetupToken(now = Date.now()) {
    const subject = this.database.readMeta('subject')
    if (
      !subject ||
      (!this.database.readMeta('migrationExportedAt') && !this.database.readMeta('freshStartAt'))
    )
      throw new Error('必须先导入完整空间或明确初始化全新空间，才能创建 Passkey 设置令牌')
    if (this.database.db.prepare('SELECT 1 FROM passkeys LIMIT 1').get())
      throw new Error('Passkey 已初始化；请使用已登录会话或恢复码添加凭据')
    const token = randomBytes(32).toString('base64url')
    this.database.transaction(() => {
      this.database.writeMeta('passkeySetupTokenHash', hash(token))
      this.database.writeMeta('passkeySetupTokenExpiresAt', String(now + 15 * 60_000))
    })
    return token
  }

  createFreshAccountSetupToken(now = Date.now()) {
    const populatedTables = [
      'maps',
      'nodes',
      'markers',
      'tabs',
      'versions',
      'field_versions',
      'deletion_records',
      'operations',
      'events',
      'scheduled_jobs',
      'sessions',
      'passkeys',
      'auth_challenges',
      'recovery_codes',
    ]
    return this.database.transaction(() => {
      if (
        this.database.readMeta('subject') ||
        this.database.readMeta('migrationExportedAt') ||
        this.database.readMeta('freshStartAt') ||
        Number(this.database.readMeta('seq') ?? 0) !== 0 ||
        populatedTables.some(
          (table) => this.database.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined,
        )
      )
        throw new Error('数据库不是空白新空间；为避免覆盖数据，拒绝初始化')

      const subject = `mindme-${randomUUID()}`
      this.database.writeMeta('subject', subject)
      this.database.writeMeta('freshStartAt', String(now))
      const token = randomBytes(32).toString('base64url')
      this.database.writeMeta('passkeySetupTokenHash', hash(token))
      this.database.writeMeta('passkeySetupTokenExpiresAt', String(now + 15 * 60_000))
      return token
    })
  }

  private setupTokenIsValid(token: string, now = Date.now()) {
    const expected = this.database.readMeta('passkeySetupTokenHash')
    const expiresAt = Number(this.database.readMeta('passkeySetupTokenExpiresAt'))
    return (
      !!expected &&
      Number.isFinite(expiresAt) &&
      expiresAt > now &&
      equalHash(hash(token), expected)
    )
  }

  private prepareChallenge(now: number) {
    this.database.db.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').run(now)
    const count = this.database.db
      .prepare('SELECT COUNT(*) AS count FROM auth_challenges')
      .get() as { count: number }
    if (count.count >= 100) throw new Error('认证请求过多，请稍后重试')
  }

  async registrationOptions(input: { sub?: string; setupToken?: string; now?: number }) {
    const now = input.now ?? Date.now()
    const boundSub = this.database.readMeta('subject')
    const existing = this.database.db
      .prepare('SELECT credential_id,transports FROM passkeys WHERE sub=?')
      .all(boundSub) as { credential_id: string; transports: string }[]
    const setup =
      !input.sub || (existing.length === 0 && this.setupTokenIsValid(input.setupToken ?? '', now))
    if (
      !boundSub ||
      (setup ? !this.setupTokenIsValid(input.setupToken ?? '', now) : input.sub !== boundSub)
    )
      throw new Error('账号未授权添加 Passkey')
    this.prepareChallenge(now)
    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: createHash('sha256').update(boundSub).digest(),
      userName: 'mindme-user',
      userDisplayName: 'Mindme 用户',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      excludeCredentials: existing.map((item) => ({
        id: item.credential_id,
        transports: JSON.parse(item.transports) as string[],
      })),
      timeout: 60_000,
    })
    const flowId = randomUUID()
    this.database.db
      .prepare(
        'INSERT INTO auth_challenges(flow_id,kind,challenge,sub,setup_token_hash,expires_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        flowId,
        'register',
        options.challenge,
        boundSub,
        setup ? hash(input.setupToken!) : null,
        now + 5 * 60_000,
      )
    return { flowId, options }
  }

  private takeFlow(flowId: string, kind: string, now = Date.now()) {
    const row = this.database.transaction(() => {
      const row = this.database.db
        .prepare('SELECT * FROM auth_challenges WHERE flow_id=? AND kind=?')
        .get(flowId, kind) as Flow | undefined
      this.database.db.prepare('DELETE FROM auth_challenges WHERE flow_id=?').run(flowId)
      return row
    })
    if (!row || row.expires_at <= now) throw new Error('认证流程已过期，请重新开始')
    return row
  }

  async verifyRegistration(input: {
    flowId: string
    response: RegistrationResponseJSON
    sub?: string
    setupToken?: string
    now?: number
  }) {
    const now = input.now ?? Date.now()
    const flow = this.takeFlow(input.flowId, 'register', now)
    const setup = flow.setup_token_hash !== null
    if (
      flow.sub !== this.database.readMeta('subject') ||
      (setup
        ? !this.setupTokenIsValid(input.setupToken ?? '', now) ||
          !equalHash(hash(input.setupToken ?? ''), flow.setup_token_hash ?? '')
        : input.sub !== flow.sub)
    )
      throw new Error('账号授权已失效，请重新登录')
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: true,
    })
    if (!result.verified) throw new Error('Passkey 注册验证失败')
    const credential = result.registrationInfo.credential
    const codes = setup ? codeSet() : undefined
    this.database.transaction(() => {
      if (setup && !this.setupTokenIsValid(input.setupToken ?? '', now))
        throw new Error('设置令牌已使用或过期')
      this.database.db
        .prepare(
          'INSERT INTO passkeys(credential_id,public_key,counter,transports,device_type,backed_up,sub) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          credential.id,
          Buffer.from(credential.publicKey).toString('base64url'),
          credential.counter,
          JSON.stringify(credential.transports ?? []),
          result.registrationInfo.credentialDeviceType,
          result.registrationInfo.credentialBackedUp ? 1 : 0,
          flow.sub,
        )
      if (setup) {
        this.replaceRecoveryCodes(codes!, now)
        this.database.writeMeta('passkeySetupTokenHash', '')
        this.database.writeMeta('passkeySetupTokenExpiresAt', '0')
      }
    })
    return { sub: flow.sub, recoveryCodes: codes }
  }

  async authenticationOptions(now = Date.now()) {
    this.prepareChallenge(now)
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: [],
      userVerification: 'required',
      timeout: 60_000,
    })
    const flowId = randomUUID()
    this.database.db
      .prepare(
        'INSERT INTO auth_challenges(flow_id,kind,challenge,sub,setup_token_hash,expires_at) VALUES(?,?,?,?,?,?)',
      )
      .run(flowId, 'authenticate', options.challenge, '', null, now + 5 * 60_000)
    return { flowId, options }
  }

  async verifyAuthentication(
    flowId: string,
    response: AuthenticationResponseJSON,
    now = Date.now(),
  ) {
    const flow = this.takeFlow(flowId, 'authenticate', now)
    const row = this.database.db
      .prepare('SELECT * FROM passkeys WHERE credential_id=?')
      .get(response.id) as StoredCredential | undefined
    if (!row) throw new Error('Passkey 不受此账号识别')
    const credential: WebAuthnCredential = {
      id: row.credential_id,
      publicKey: Buffer.from(row.public_key, 'base64url'),
      counter: row.counter,
      transports: JSON.parse(row.transports) as string[],
    }
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential,
      requireUserVerification: true,
    })
    if (!result.verified) throw new Error('Passkey 登录验证失败')
    this.database.db
      .prepare('UPDATE passkeys SET counter=?,device_type=?,backed_up=? WHERE credential_id=?')
      .run(
        result.authenticationInfo.newCounter,
        result.authenticationInfo.credentialDeviceType,
        result.authenticationInfo.credentialBackedUp ? 1 : 0,
        row.credential_id,
      )
    return row.sub
  }

  private replaceRecoveryCodes(codes: string[], now = Date.now()) {
    this.database.db.prepare('DELETE FROM recovery_codes').run()
    const insert = this.database.db.prepare(
      'INSERT INTO recovery_codes(code_hash,created_at) VALUES(?,?)',
    )
    for (const code of codes) insert.run(hash(normalizeCode(code)), now)
  }

  async recover(code: string, now = Date.now()) {
    if (!/^[a-f0-9-]{39}$/i.test(code)) throw new Error('恢复码无效或已使用')
    const result = this.database.transaction(() => {
      const attempt = this.database.db
        .prepare('SELECT attempts,window_started,blocked_until FROM recovery_attempts WHERE id=1')
        .get() as { attempts: number; window_started: number; blocked_until: number } | undefined
      if (attempt?.blocked_until && attempt.blocked_until > now)
        return { error: '恢复登录尝试过多，请稍后重试' }
      const digest = hash(normalizeCode(code))
      const record = this.database.db
        .prepare('SELECT code_hash FROM recovery_codes WHERE code_hash=?')
        .get(digest) as { code_hash: string } | undefined
      if (!record) {
        const active = attempt && now - attempt.window_started < 15 * 60_000
        const attempts = active ? attempt.attempts + 1 : 1
        const blockedUntil = attempts >= 5 ? now + 15 * 60_000 : 0
        this.database.db
          .prepare(
            'INSERT INTO recovery_attempts(id,attempts,window_started,blocked_until) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,window_started=excluded.window_started,blocked_until=excluded.blocked_until',
          )
          .run(
            attempts,
            attempt?.window_started && active ? attempt.window_started : now,
            blockedUntil,
          )
        return { error: '恢复码无效或已使用' }
      }
      this.database.db.prepare('DELETE FROM recovery_codes WHERE code_hash=?').run(digest)
      this.database.db.prepare('DELETE FROM recovery_attempts WHERE id=1').run()
      return { sub: this.database.readMeta('subject') }
    })
    if ('error' in result) throw new Error(result.error)
    if (!result.sub) throw new Error('空间账号尚未绑定')
    return { sub: result.sub }
  }

  async rotateRecoveryCodes(sub: string, now = Date.now()) {
    const codes = codeSet()
    this.database.transaction(() => {
      if (sub !== this.database.readMeta('subject')) throw new Error('账号不匹配')
      this.replaceRecoveryCodes(codes, now)
    })
    return codes
  }
}
