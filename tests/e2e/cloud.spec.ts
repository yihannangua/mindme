import { writeFile } from 'node:fs/promises'
import { expect, test, type BrowserContext } from '@playwright/test'
const base = process.env.MINDME_TEST_ORIGIN ?? 'http://localhost:8791'
async function login(context: BrowserContext) {
  const response = await context.request.post(`${base}/auth/dev-login`, {
    headers: { origin: base },
    data: {},
  })
  expect(response.status()).toBe(200)
  return (await (await context.request.get(`${base}/auth/session`)).json()) as {
    authenticated: boolean
    csrf: string
  }
}
test('节点字体、字号和背景跨设备同步并在重新打开后保留', async ({ browser }) => {
  const a = await browser.newContext(),
    b = await browser.newContext()
  try {
    await login(a)
    await login(b)
    const pageA = await a.newPage(),
      pageB = await b.newPage()
    const title = `样式同步-${Date.now()}`
    await pageA.goto(base)
    await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
      timeout: 20000,
    })
    await pageA.getByRole('button', { name: '新建脑图', exact: true }).first().click()
    await pageA.getByLabel('脑图名称').fill(title)
    await pageA.getByRole('button', { name: '创建脑图', exact: true }).click()
    await pageA.getByRole('button', { name: `节点 ${title}`, exact: true }).click()
    await pageA.getByLabel('字体', { exact: true }).selectOption('serif')
    await pageA.getByLabel('字号', { exact: true }).selectOption('30')
    await pageA.getByRole('button', { name: '背景色 #273b48' }).click()
    await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
      timeout: 20000,
    })
    await pageB.goto(base)
    await expect(
      pageB.getByRole('navigation').getByRole('button', { name: title, exact: true }),
    ).toBeVisible({ timeout: 20000 })
    await pageB.getByRole('navigation').getByRole('button', { name: title, exact: true }).click()
    const root = pageB.getByRole('button', { name: `节点 ${title}`, exact: true })
    await expect(root.locator('text.node-label')).toHaveCSS('font-size', '30px')
    await expect(root.locator('rect').first()).toHaveCSS('fill', 'rgb(39, 59, 72)')
    await root.click()
    await expect(pageB.getByLabel('字体', { exact: true })).toHaveValue('serif')
    await pageB.reload()
    await expect(root.locator('text.node-label')).toHaveCSS('font-size', '30px')
    await expect(root.locator('rect').first()).toHaveCSS('fill', 'rgb(39, 59, 72)')
  } finally {
    await a.close()
    await b.close()
  }
})
test('HTTP 鉴权、CSRF、越权、路由边界与退出后会话失效', async ({ browser }) => {
  const anonymous = await browser.newContext(),
    authenticated = await browser.newContext()
  expect((await anonymous.request.post(`${base}/api/sync`, { data: {} })).status()).toBe(401)
  expect(
    (
      await anonymous.request.post(`${base}/auth/dev-login`, {
        headers: { origin: 'https://evil.example' },
        data: {},
      })
    ).status(),
  ).toBe(403)
  const session = await login(authenticated)
  expect(session.authenticated).toBe(true)
  expect(
    (
      await authenticated.request.post(`${base}/api/sync`, {
        data: { schemaVersion: 1, since: 0, operations: [] },
      })
    ).status(),
  ).toBe(403)
  const headers = { origin: base, 'X-CSRF-Token': session.csrf }
  const valid = await authenticated.request.post(`${base}/api/sync`, {
    headers,
    data: { schemaVersion: 1, since: 0, operations: [] },
  })
  expect(valid.status()).toBe(200)
  expect((await valid.json()).schemaVersion).toBe(1)
  expect((await authenticated.request.get(`${base}/api/not-found`)).status()).toBe(404)
  const staticPage = await anonymous.request.get(`${base}/nested/spa-route`)
  expect(staticPage.headers()['content-type']).toContain('text/html')
  expect(staticPage.headers()['x-content-type-options']).toBe('nosniff')
  expect(staticPage.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(staticPage.headers()['cross-origin-opener-policy']).toBe('same-origin-allow-popups')
  const cachedWorker = await anonymous.request.get(`${base}/sw.js`)
  expect(cachedWorker.headers()['cache-control']).toBe('no-cache')
  const cookies = await authenticated.cookies(),
    oldCookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  expect((await authenticated.request.post(`${base}/auth/logout`, { headers })).status()).toBe(200)
  expect(
    (
      await anonymous.request.post(`${base}/api/sync`, {
        headers: { ...headers, cookie: oldCookie },
        data: { schemaVersion: 1, since: 0, operations: [] },
      })
    ).status(),
  ).toBe(401)
  await anonymous.close()
  await authenticated.close()
})
test('两台设备新建、字段合并、离线重连与删除冲突找回', async ({ browser }, info) => {
  const a = await browser.newContext(),
    b = await browser.newContext()
  await login(a)
  await login(b)
  const pageA = await a.newPage(),
    pageB = await b.newPage(),
    title = `同步验收-${Date.now()}`
  const errors: string[] = []
  pageA.on('pageerror', (e) => errors.push(e.message))
  pageB.on('pageerror', (e) => errors.push(e.message))
  await pageA.goto(base)
  await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 20000,
  })
  await pageA.getByRole('button', { name: '新建脑图', exact: true }).first().click()
  await pageA.getByLabel('脑图名称').fill(title)
  await pageA.getByRole('button', { name: '创建脑图', exact: true }).click()
  const rootA = pageA.getByRole('button', { name: `节点 ${title}`, exact: true })
  await expect(rootA).toBeVisible()
  await rootA.click()
  await pageA.getByLabel('脑图画布', { exact: true }).press('Tab')
  const nodeA = pageA.getByRole('button', { name: '节点 新主题', exact: true })
  await nodeA.dblclick()
  await pageA.getByLabel('编辑节点文字').fill('共享子主题')
  await pageA.getByLabel('编辑节点文字').press('Enter')
  await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await pageB.goto(base)
  await expect(pageB.getByRole('button', { name: title, exact: true })).toBeVisible({
    timeout: 15000,
  })
  await pageB.getByRole('navigation').getByRole('button', { name: title, exact: true }).click()
  const nodeB = pageB.getByRole('button', { name: '节点 共享子主题', exact: true })
  await expect(nodeB).toBeVisible({ timeout: 15000 })
  await nodeB.click()
  await pageB.getByRole('button', { name: '旗子 blue', exact: true }).click()
  await pageA.getByRole('button', { name: '节点 共享子主题', exact: true }).dblclick()
  await pageA.getByLabel('编辑节点文字').fill('修改了文字')
  await pageA.getByLabel('编辑节点文字').press('Enter')
  const changedB = pageB.getByRole('button', { name: '节点 修改了文字', exact: true })
  await expect(changedB).toBeVisible({ timeout: 15000 })
  await changedB.click()
  await expect(pageB.getByRole('button', { name: '旗子 blue', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(pageB.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await b.setOffline(true)
  await changedB.dblclick()
  await pageB.getByLabel('编辑节点文字').fill('离线本机修改')
  await pageB.getByLabel('编辑节点文字').press('Enter')
  await expect(pageB.getByText('本地已保存', { exact: true })).toBeVisible()
  await pageA.getByRole('button', { name: '节点 修改了文字', exact: true }).dblclick()
  await pageA.getByLabel('编辑节点文字').fill('稍后在线修改')
  await pageA.getByLabel('编辑节点文字').press('Enter')
  await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await b.setOffline(false)
  await expect(pageB.getByRole('button', { name: '节点 稍后在线修改', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await pageB.getByRole('button', { name: /冲突草稿 ·/ }).click()
  await expect(pageB.getByLabel('冲突草稿内容')).toHaveValue(/离线本机修改/)
  await pageB.getByLabel('关闭对话框').click()
  await pageA.getByRole('button', { name: '节点 稍后在线修改', exact: true }).click()
  await pageA.getByRole('button', { name: '删除分支', exact: true }).click()
  await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await expect(pageB.getByRole('button', { name: '节点 稍后在线修改', exact: true })).toHaveCount(
    0,
    { timeout: 15000 },
  )
  await pageA.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(pageB.getByRole('button', { name: '节点 稍后在线修改', exact: true })).toBeVisible({
    timeout: 15000,
  })
  const latencyMs: number[] = []
  for (let i = 0; i < 3; i++) {
    const current = i ? `同步延迟样本 ${i - 1}` : '稍后在线修改'
    await pageA.getByRole('button', { name: `节点 ${current}`, exact: true }).dblclick()
    await pageA.getByLabel('编辑节点文字').fill(`同步延迟样本 ${i}`)
    const start = Date.now()
    await pageA.getByLabel('编辑节点文字').press('Enter')
    await expect(
      pageB.getByRole('button', { name: `节点 同步延迟样本 ${i}`, exact: true }),
    ).toBeVisible({ timeout: 15000 })
    latencyMs.push(Date.now() - start)
  }
  const metrics = {
    date: '2026-10-16',
    environment: process.env.MINDME_TEST_ORIGIN
      ? '本机 Node/SQLite 独立服务器，两个隔离 Chromium 会话，非公网时延'
      : '本机 Cloudflare 模拟器，两个隔离 Chromium 会话，非公网时延',
    onlineLatencyMs: latencyMs,
    targetPassed: latencyMs.every((ms) => ms <= 2000),
  }
  await writeFile(info.outputPath('sync-performance.json'), JSON.stringify(metrics, null, 2))
  await info.attach('在线同步延迟', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
  expect(latencyMs.every((ms) => ms <= 2000)).toBe(true)
  expect(errors).toEqual([])
  await a.close()
  await b.close()
})

test('生产应用壳缓存支持已访问设备断网后刷新和继续编辑', async ({ browser }) => {
  const context = await browser.newContext(),
    page = await context.newPage()
  await page.goto(base)
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  const node = page.locator('.root-node').first()
  await node.dblclick()
  await page.getByLabel('编辑节点文字').fill('应用壳离线验收')
  await page.getByLabel('编辑节点文字').press('Enter')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('button', { name: '节点 应用壳离线验收', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '节点 应用壳离线验收', exact: true }).dblclick()
  await page.getByLabel('编辑节点文字').fill('断网刷新后继续编辑')
  await page.getByLabel('编辑节点文字').press('Enter')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await context.close()
})

test('同批永久删除后复用名称不会触发 SQLite 中间状态的唯一约束', async ({ browser }) => {
  const { createMap } = await import('../../src/domain/model')
  const { execute } = await import('../../src/domain/commands')
  const { diffSpace } = await import('../../src/domain/operations')
  const context = await browser.newContext(),
    session = await login(context),
    headers = { origin: base, 'X-CSRF-Token': session.csrf }
  const sync = async (since: number, operations: unknown[]) =>
    context.request.post(`${base}/api/sync`, {
      headers,
      data: { schemaVersion: 1, since, operations },
    })
  const initial = await (await sync(0, [])).json(),
    ctx = { now: Date.now(), id: () => crypto.randomUUID() },
    suffix = Date.now()
  const a = createMap(initial.space, `保留-${suffix}`, ctx),
    keepId = Object.keys(a.maps).find((id) => !initial.space.maps[id])!
  const b = createMap(a, `释放-${suffix}`, ctx),
    deleteId = Object.keys(b.maps).find((id) => !a.maps[id])!,
    deviceId = crypto.randomUUID()
  let seq = 0
  const op = (before: typeof a, after: typeof a) => ({
    schemaVersion: 1,
    opId: crypto.randomUUID(),
    stamp: { deviceId, deviceSeq: ++seq, at: Date.now(), uncertainty: 0 },
    baseRevision: initial.seq,
    state: 'pending',
    attempts: 0,
    changes: diffSpace(before, after),
  })
  const created = await sync(initial.seq, [op(initial.space, b)])
  expect(created.status()).toBe(200)
  const trash = execute(b, deleteId, { type: 'trash' }, ctx).space,
    purged = execute(trash, deleteId, { type: 'purge' }, ctx).space,
    renamed = execute(
      purged,
      keepId,
      { type: 'text', nodeId: purged.maps[keepId].rootId, text: `释放-${suffix}` },
      ctx,
    ).space
  const result = await sync(0, [op(b, trash), op(trash, purged), op(purged, renamed)])
  expect(result.status()).toBe(200)
  const body = await result.json()
  expect(body.results.every((item: { status: string }) => item.status === 'accepted')).toBe(true)
  expect(body.space.maps[keepId].title).toBe(`释放-${suffix}`)
  expect(body.space.maps[deleteId]).toBeUndefined()
  await context.close()
})

test('已登录设备断网刷新后修改，认证接口重连暂时失败仍自动续传且不误报未配置', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext()
  await login(a)
  await login(b)
  const page = await a.newPage(),
    title = `离线恢复-${Date.now()}`
  await page.goto(base)
  await expect(page.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await page.getByRole('button', { name: '新建脑图', exact: true }).first().click()
  await page.getByLabel('脑图名称').fill(title)
  await page.getByRole('button', { name: '创建脑图', exact: true }).click()
  await page.getByRole('button', { name: `节点 ${title}`, exact: true }).click()
  await page.getByLabel('脑图画布', { exact: true }).press('Tab')
  await expect(page.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload()
  await expect(page.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await a.setOffline(true)
  await page.reload()
  await page.getByRole('tab', { name: title, exact: true }).click()
  await page.getByRole('button', { name: '节点 新主题', exact: true }).dblclick()
  await page.getByLabel('编辑节点文字').fill('断网刷新后保留的修改')
  await page.getByLabel('编辑节点文字').press('Enter')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await expect(page.getByText('云端尚未配置。', { exact: false })).toHaveCount(0)
  await expect(
    page.getByText('当前离线，修改已保留在本机；恢复联网后自动重试。', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '重试同步', exact: true })).toBeVisible()
  let inspections = 0
  await page.route('**/auth/session', async (route) => {
    inspections++
    if (inspections <= 2)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '网络刚恢复，认证暂不可达' }),
      })
    else await route.continue()
  })
  await a.setOffline(false)
  await expect(page.getByRole('heading', { name: '已同步', exact: true })).toBeVisible({
    timeout: 20000,
  })
  expect(inspections).toBeGreaterThanOrEqual(3)
  await expect(page.getByText('云端尚未配置。', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭对话框', exact: true }).click()
  const other = await b.newPage()
  await other.goto(base)
  await expect(other.getByRole('tab', { name: title, exact: true })).toBeVisible({ timeout: 15000 })
  await other.getByRole('tab', { name: title, exact: true }).click()
  await expect(
    other.getByRole('button', { name: '节点 断网刷新后保留的修改', exact: true }),
  ).toBeVisible({ timeout: 15000 })
  await page.reload()
  await page.getByRole('tab', { name: title, exact: true }).click()
  await expect(
    page.getByRole('button', { name: '节点 断网刷新后保留的修改', exact: true }),
  ).toBeVisible()
  await a.close()
  await b.close()
})

test('首次认证短暂失败时无需网络事件自动重试，状态未知时不显示云端未配置', async ({ browser }) => {
  const context = await browser.newContext()
  await login(context)
  const page = await context.newPage()
  let checks = 0
  await page.route('**/auth/session', async (route) => {
    checks++
    if (checks <= 2)
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
    else await route.continue()
  })
  await page.goto(base)
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await expect(page.getByText('云端尚未配置。', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重试同步', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '已同步', exact: true })).toBeVisible({
    timeout: 20000,
  })
  expect(checks).toBeGreaterThanOrEqual(3)
  await context.close()
})

test('同步会话失效时界面保持已配置并可重试恢复，不清空待提交修改', async ({ browser }) => {
  const context = await browser.newContext()
  await login(context)
  const page = await context.newPage()
  let expired = false,
    refreshAttempts = 0
  // 同时模拟访问会话与刷新失效，避免有效会话被客户端自动恢复。
  await page.route('**/api/sync', async (route) => {
    if (expired) await route.fulfill({ status: 401, json: {} })
    else await route.continue()
  })
  await page.route('**/auth/session', async (route) => {
    if (expired)
      await route.fulfill({
        json: { configured: true, authenticated: false, serverTime: Date.now() },
      })
    else await route.continue()
  })
  await page.route('**/auth/refresh', async (route) => {
    if (expired) {
      refreshAttempts++
      await route.fulfill({ status: 401, json: {} })
    } else await route.continue()
  })
  await page.goto(base)
  await expect(page.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  expired = true
  // 真实编辑会立即唤醒同步，也验证失效期间的本地修改没有被清空。
  const pendingText = `会话失效仍保留-${Date.now()}`
  await page.getByRole('button', { name: '节点 我的第一个脑图', exact: true }).dblclick()
  await page.getByLabel('编辑节点文字').fill(pendingText)
  await page.getByLabel('编辑节点文字').press('Enter')
  await expect(page.getByRole('button', { name: '登录以同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  expect(refreshAttempts).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: `节点 ${pendingText}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await expect(page.getByText('云端尚未配置。', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toHaveCount(0)
  expired = false
  await page.getByRole('button', { name: '重试同步', exact: true }).click()
  await expect(page.getByRole('heading', { name: '已同步', exact: true })).toBeVisible({
    timeout: 15000,
  })
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  await page.reload()
  await expect(page.getByRole('button', { name: `节点 ${pendingText}`, exact: true })).toBeVisible()
  await context.close()
})

test('两端批量拖拽挂接整批同步，另一端保持后代层级并收到一次撤销恢复', async ({ browser }) => {
  const a = await browser.newContext(),
    b = await browser.newContext()
  try {
    await login(a)
    await login(b)
    const pageA = await a.newPage(),
      pageB = await b.newPage(),
      title = `批量挂接联调-${Date.now()}`
    await pageA.goto(base)
    await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
      timeout: 15000,
    })
    await pageA.getByRole('button', { name: '新建脑图', exact: true }).first().click()
    await pageA.getByLabel('脑图名称').fill(title)
    await pageA.getByRole('button', { name: '创建脑图', exact: true }).click()
    const root = pageA.getByRole('button', { name: `节点 ${title}`, exact: true })
    for (const text of ['待移动甲', '待移动乙', '批量目标']) {
      await root.click()
      await pageA.keyboard.press('Tab')
      await pageA.getByRole('button', { name: '节点 新主题', exact: true }).dblclick()
      await pageA.getByLabel('编辑节点文字').fill(text)
      await pageA.getByLabel('编辑节点文字').press('Enter')
      await expect(pageA.getByRole('button', { name: `节点 ${text}`, exact: true })).toBeVisible()
    }
    const nodeA = pageA.getByRole('button', { name: '节点 待移动甲', exact: true }),
      nodeB = pageA.getByRole('button', { name: '节点 待移动乙', exact: true }),
      target = pageA.getByRole('button', { name: '节点 批量目标', exact: true })
    await nodeA.click()
    await pageA.keyboard.press('Tab')
    const child = pageA.getByRole('button', { name: '节点 新主题', exact: true })
    await expect(child).toBeVisible()
    await expect(pageA.getByRole('button', { name: '已同步', exact: true })).toBeVisible({
      timeout: 15000,
    })
    await pageB.goto(base)
    await pageB.getByRole('navigation').getByRole('button', { name: title, exact: true }).click()
    const remoteA = pageB.getByRole('button', { name: '节点 待移动甲', exact: true }),
      remoteB = pageB.getByRole('button', { name: '节点 待移动乙', exact: true }),
      targetId = await target.getAttribute('data-node-id'),
      rootId = await root.getAttribute('data-node-id'),
      aId = await nodeA.getAttribute('data-node-id')
    await expect(remoteA).toBeVisible()
    await nodeA.click()
    await nodeB.click({ modifiers: ['Alt'] })
    const from = (await nodeA.boundingBox())!,
      to = (await target.boundingBox())!
    await pageA.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await pageA.mouse.down()
    await pageA.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
    await expect(pageA.locator('.attach-hint')).toBeVisible()
    await pageA.mouse.up()
    await expect(remoteA).toHaveAttribute('data-parent-id', targetId!, { timeout: 15000 })
    await expect(remoteB).toHaveAttribute('data-parent-id', targetId!, { timeout: 15000 })
    await pageB.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect(pageB.getByRole('button', { name: '节点 新主题', exact: true })).toHaveAttribute(
      'data-parent-id',
      aId!,
    )
    await pageA.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(remoteA).toHaveAttribute('data-parent-id', rootId!, { timeout: 15000 })
    await expect(remoteB).toHaveAttribute('data-parent-id', rootId!, { timeout: 15000 })
  } finally {
    await a.close()
    await b.close()
  }
})
