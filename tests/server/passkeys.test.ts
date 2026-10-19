import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerDatabase } from '../../server/database'
import { PasskeyService } from '../../server/passkeys'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function fixture(options: { migrated?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mindme-passkey-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const database = new ServerDatabase(join(dir, 'mindme.sqlite'))
  cleanup.push(async () => database.close())
  if (options.migrated !== false) {
    database.writeMeta('subject', 'legacy-google-subject')
    database.writeMeta('migrationExportedAt', String(Date.now()))
  }
  const service = new PasskeyService(database, 'https://mindme.example')
  return { database, service }
}

const hashCode = (value: string) =>
  createHash('sha256')
    .update(value.toLowerCase().replace(/[^a-f0-9]/g, ''))
    .digest('hex')

describe('Passkey 和离线恢复码', () => {
  it('仅允许在真正空白数据库上初始化全新空间', async () => {
    const { database, service } = await fixture({ migrated: false })
    const token = service.createFreshAccountSetupToken(5000)
    expect(token).toHaveLength(43)
    expect(database.readMeta('subject')).toMatch(/^mindme-[0-9a-f-]{36}$/)
    expect(database.readMeta('freshStartAt')).toBe('5000')
    await expect(
      service.registrationOptions({ setupToken: token, now: 5001 }),
    ).resolves.toMatchObject({
      options: { rp: { id: 'mindme.example' } },
    })
  })

  it('发现任何已有脑图数据时拒绝全新初始化且不更改绑定', async () => {
    const { database, service } = await fixture()
    const originalSubject = database.readMeta('subject')
    expect(() => service.createFreshAccountSetupToken()).toThrow('不是空白新空间')
    expect(database.readMeta('subject')).toBe(originalSubject)
    expect(database.readMeta('freshStartAt')).toBeUndefined()
  })

  it('首次设置必须以完整迁移后的原空间身份为目标，且令牌限时一次', async () => {
    const { database, service } = await fixture()
    const token = service.createSetupToken(1000)
    const { flowId, options } = await service.registrationOptions({ setupToken: token, now: 1001 })
    expect(flowId).toMatch(/^[0-9a-f-]{36}$/)
    expect(options.rp.id).toBe('mindme.example')
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    expect(() => database.db.prepare('SELECT challenge FROM auth_challenges').get()).not.toThrow()
    await expect(
      service.registrationOptions({ setupToken: 'invalid', now: 1001 }),
    ).rejects.toThrow()
    await expect(service.registrationOptions({ setupToken: token, now: 901_000 })).rejects.toThrow(
      '账号未授权添加 Passkey',
    )
  })

  it('恢复码仅存哈希且一次性消费，不影响其他未使用恢复码', async () => {
    const { database, service } = await fixture()
    const firstCode = '0123-4567-89ab-cdef-0123-4567-89ab-cdef'
    const secondCode = '1111-2222-3333-4444-5555-6666-7777-8888'
    database.db
      .prepare('INSERT INTO recovery_codes(code_hash,created_at) VALUES(?,?)')
      .run(hashCode(firstCode), 1000)
    database.db
      .prepare('INSERT INTO recovery_codes(code_hash,created_at) VALUES(?,?)')
      .run(hashCode(secondCode), 1000)

    const firstRecovery = await service.recover(firstCode, 2000)
    expect(firstRecovery.sub).toBe('legacy-google-subject')
    expect(database.db.prepare('SELECT code_hash FROM recovery_codes').all()).toHaveLength(1)
    expect(
      database.db
        .prepare('SELECT code_hash FROM recovery_codes WHERE code_hash=?')
        .get(hashCode(secondCode)),
    ).toBeDefined()
    await expect(service.recover(firstCode, 2001)).rejects.toThrow('恢复码无效或已使用')

    await expect(service.recover(secondCode, 3000)).resolves.toMatchObject({
      sub: 'legacy-google-subject',
    })
    expect(database.db.prepare('SELECT code_hash FROM recovery_codes').all()).toHaveLength(0)
  })

  it('已登录用户轮换恢复码时整组替换且只返回一次', async () => {
    const { database, service } = await fixture()
    database.db
      .prepare('INSERT INTO recovery_codes(code_hash,created_at) VALUES(?,?)')
      .run(hashCode('0123-4567-89ab-cdef-0123-4567-89ab-cdef'), 1000)
    const codes = await service.rotateRecoveryCodes('legacy-google-subject', 2000)
    expect(codes).toHaveLength(10)
    expect(database.db.prepare('SELECT code_hash FROM recovery_codes').all()).toHaveLength(10)
    expect(
      database.db
        .prepare('SELECT code_hash FROM recovery_codes WHERE code_hash=?')
        .get(hashCode(codes[0])),
    ).toBeDefined()
  })

  it('连续五次错误恢复码会持久触发限流', async () => {
    const { database, service } = await fixture()
    const invalidCode = 'ffff-ffff-ffff-ffff-ffff-ffff-ffff-ffff'
    for (let index = 0; index < 5; index++)
      await expect(service.recover(invalidCode, 1000 + index)).rejects.toThrow('恢复码无效')
    const attempt = database.db
      .prepare('SELECT attempts,blocked_until FROM recovery_attempts WHERE id=1')
      .get() as { attempts: number; blocked_until: number }
    expect(attempt.attempts).toBe(5)
    expect(attempt.blocked_until).toBeGreaterThan(1000)
    await expect(service.recover(invalidCode, 2000)).rejects.toThrow('尝试过多')
  })
})
