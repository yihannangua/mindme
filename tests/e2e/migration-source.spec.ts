import { expect, test } from '@playwright/test'
import { validateMigration } from '../../shared/state'
test('旧对象只读完整导出需要有效短期令牌，保留修订及操作去重结果', async ({ request }) => {
  const base = 'http://localhost:8791',
    token = process.env.MINDME_TEST_MIGRATION_TOKEN!
  expect((await request.post(`${base}/api/migration/export`)).status()).toBe(404)
  expect(
    (
      await request.post(`${base}/api/migration/export`, {
        headers: { authorization: 'Bearer wrong' },
      })
    ).status(),
  ).toBe(404)
  const response = await request.post(`${base}/api/migration/export`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(response.status()).toBe(200)
  const snapshot = await response.json()
  expect(() => validateMigration(snapshot)).not.toThrow()
  expect(snapshot.format).toBe('mindme-server')
  expect(snapshot.state.seq).toBeGreaterThan(0)
  expect(Object.keys(snapshot.state.results).length).toBeGreaterThan(0)
  expect(response.headers()['cache-control']).toBe('no-store')
  const repeat = await (
    await request.post(`${base}/api/migration/export`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()
  expect(repeat.state).toEqual(snapshot.state)
})
