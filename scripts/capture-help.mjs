import { copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

// 仅在独立的本地演示会话中采集，不读取用户已有浏览器数据或生产内容。
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:4173/')
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))
  throw new Error('帮助配图只允许使用本机 HTTP 开发地址')
const output = join(tmpdir(), 'mindme-help-capture')
const assetDirectory = fileURLToPath(new URL('../src/assets/help/', import.meta.url))
await mkdir(output, { recursive: true })
await mkdir(assetDirectory, { recursive: true })
const browser = await chromium.launch()
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    reducedMotion: 'reduce',
  })
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.origin === origin.origin ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  await page.goto(origin.href)
  const node = (text) => page.getByRole('button', { name: `节点 ${text}`, exact: true })
  await expect(node('我的第一个脑图')).toBeVisible()
  await node('想要探索的事').click()
  await page.getByLabel('脑图画布', { exact: true }).press('Tab')
  await expect(node('新主题')).toBeVisible()
  await node('新主题').dblclick()
  await page.getByLabel('编辑节点文字').fill('阅读一本书')
  await page.getByLabel('编辑节点文字').press('Enter')
  await node('想要探索的事').click()
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)

  async function mark(locator, number, position = 'left') {
    const box = await locator.boundingBox()
    if (!box) throw new Error('配图目标控件不可见')
    await page.evaluate(
      ({ box, number, position }) => {
        const badge = document.createElement('span')
        badge.dataset.helpCapture = 'true'
        badge.textContent = String(number)
        Object.assign(badge.style, {
          position: 'fixed',
          zIndex: '9999',
          pointerEvents: 'none',
          left: `${position === 'right' ? box.x + box.width - 30 : position === 'outside-left' ? box.x - 24 : box.x + 6}px`,
          top: `${position === 'below-left' ? box.y + box.height + 3 : box.y + 5}px`,
          width: '23px',
          height: '23px',
          display: 'grid',
          placeItems: 'center',
          borderRadius: '50%',
          background: '#285e5a',
          color: '#fff',
          font: 'bold 13px sans-serif',
          border: '2px solid white',
          boxShadow: '0 1px 4px #29364030',
        })
        document.body.append(badge)
      },
      { box, number, position },
    )
  }
  async function clearMarks() {
    await page
      .locator('[data-help-capture]')
      .evaluateAll((elements) => elements.forEach((element) => element.remove()))
  }
  async function save(name, clip) {
    await page.screenshot({
      path: join(output, name),
      clip,
      animations: 'disabled',
      caret: 'hide',
      timeout: 120000,
    })
  }
  await mark(page.locator('.sidebar'), 1, 'right')
  await mark(page.locator('.tabs'), 2, 'right')
  await mark(page.getByLabel('脑图画布', { exact: true }), 3)
  await mark(page.locator('.properties'), 4, 'right')
  await mark(page.locator('.top-right'), 5, 'outside-left')
  await save('interface-overview.png')
  await clearMarks()

  const split = page.getByRole('button', { name: '左右拆分画布', exact: true })
  await split.click()
  const pane = page.locator('.workspace-pane').last()
  await expect(page.locator('.workspace-pane')).toHaveCount(2)
  await page
    .locator('.workspace-pane')
    .first()
    .getByRole('button', { name: '适应画布', exact: true })
    .click()
  await pane.getByRole('button', { name: '适应画布', exact: true }).click()
  const splitActions = pane.locator('.workspace-pane-actions')
  await mark(splitActions, 1, 'right')
  await save('split-canvas.png', { x: 200, y: 156, width: 992, height: 600 })
  await clearMarks()
  await pane.getByRole('button', { name: /当前分区：/ }).click()
  await expect(pane.getByRole('menu', { name: '分区操作' })).toBeVisible()
  await mark(pane.getByRole('menu', { name: '分区操作' }), 2, 'right')
  const paneBox = await pane.boundingBox()
  await save('choose-subtree.png', {
    x: paneBox.x,
    y: paneBox.y,
    width: paneBox.width,
    height: 540,
  })
  await clearMarks()
  const scope = pane.getByLabel('选择分区节点范围')
  await scope.selectOption({ label: '想要探索的事' })
  await expect(
    pane.getByRole('button', { name: '返回到我的第一个脑图', exact: true }),
  ).toBeVisible()
  await expect(pane.getByRole('button', { name: '节点 阅读一本书', exact: true })).toBeVisible()
  await pane.getByRole('button', { name: '适应画布', exact: true }).click()
  await mark(pane.locator('.workspace-pane-breadcrumbs'), 3, 'below-left')
  await save('return-to-map.png', { x: paneBox.x, y: paneBox.y, width: paneBox.width, height: 540 })
  console.log('帮助配图已生成：界面导览、拆分画布、选择子树、返回整图；均为本地演示会话。')
  await context.close()
} finally {
  await browser.close()
}
for (const name of [
  'interface-overview.png',
  'split-canvas.png',
  'choose-subtree.png',
  'return-to-map.png',
])
  await copyFile(join(output, name), join(assetDirectory, name))
console.log('帮助配图已复制到 src/assets/help/。')
