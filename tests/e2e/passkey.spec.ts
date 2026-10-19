import { expect, test } from '@playwright/test'
import { ServerDatabase } from '../../server/database'
import { PasskeyService } from '../../server/passkeys'

const base = 'http://localhost:8793'

test('Passkey 注册、登录与离线恢复码登录贯通原账号会话', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const authenticatorSession = await context.newCDPSession(page)
  await authenticatorSession.send('WebAuthn.enable')
  await authenticatorSession.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  const database = new ServerDatabase(process.env.MINDME_TEST_DATABASE!)
  const setupToken = new PasskeyService(database, base).createFreshAccountSetupToken()
  database.close()
  const initialSessionResponse = await context.request.get(`${base}/auth/session`)
  expect(initialSessionResponse.status()).toBe(200)
  expect(await initialSessionResponse.json()).toMatchObject({
    authMode: 'passkey',
    configured: true,
    passkeyReady: false,
    setupAvailable: true,
  })

  await page.goto(base)
  await page.getByRole('button', { name: '账号与同步' }).click()
  await page.getByLabel('首次设置令牌').fill(setupToken)
  await page.getByRole('button', { name: '创建 Passkey 并显示恢复码' }).click()
  await expect(page.getByRole('status').getByText('Passkey 已添加')).toBeVisible()
  await expect(page.locator('.recovery-codes textarea')).toBeVisible()
  expect((await page.locator('.recovery-codes textarea').inputValue()).split('\n')).toHaveLength(10)

  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('button', { name: '账号与同步' }).click()
  await page.getByRole('button', { name: '使用 Passkey 登录' }).click()
  await expect(page.getByText('已登录，修改会在本地保存后自动同步。')).toBeVisible()

  await page.getByRole('button', { name: '更换离线恢复码' }).click()
  const codeArea = page.locator('.recovery-codes textarea')
  await expect(codeArea).toBeVisible()
  const codes = (await codeArea.inputValue()).split('\n')
  expect(codes).toHaveLength(10)

  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('button', { name: '账号与同步' }).click()
  await page.getByLabel('离线恢复码').fill(codes[0])
  await page.getByRole('button', { name: '使用恢复码登录' }).click()
  await expect(page.getByRole('status').getByText('已通过离线恢复码登录')).toBeVisible()
  await expect(
    page.getByText('此恢复码已使用。请添加新的 Passkey，并随后更换剩余恢复码。'),
  ).toBeVisible()

  await page.getByRole('button', { name: '退出登录' }).click()
  await page.getByRole('button', { name: '账号与同步' }).click()
  await page.getByLabel('离线恢复码').fill(codes[0])
  await page.getByRole('button', { name: '使用恢复码登录' }).click()
  await expect(page.getByText('恢复码无效或已使用')).toBeVisible()
  await context.close()
})
