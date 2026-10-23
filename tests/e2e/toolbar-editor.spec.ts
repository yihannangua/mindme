import { expect, test } from '@playwright/test'

const node = (page: import('@playwright/test').Page, text: string) =>
  page.getByRole('button', { name: `节点 ${text}`, exact: true })
const favorite = (page: import('@playwright/test').Page, label: string) =>
  page.getByRole('button', { name: `常用图标：${label}`, exact: true })

test('画布移除快捷键、布局和节点说明，缩放与风格操作仍可使用', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByLabel('脑图画布', { exact: true })
  await expect(node(page, '我的第一个脑图')).toBeVisible()
  await expect(canvas.locator('.canvas-tip, .canvas-caption')).toHaveCount(0)
  await expect(canvas.getByText(/个节点|个可见|双击 \/ F2|顺时针平衡图/)).toHaveCount(0)
  await expect(canvas.getByRole('button', { name: '放大', exact: true })).toBeVisible()
  await canvas.getByRole('button', { name: '适应画布', exact: true }).click()
  await canvas.getByRole('button', { name: '当前画布风格：经典', exact: true }).click()
  await canvas.getByRole('option', { name: '紧凑', exact: true }).click()
  await expect(canvas).toHaveAttribute('data-style', 'compact')
})

test('常用图标统计设置次数、混合多选一次计数、右栏关闭仍可设置和整批撤销', async ({ page }) => {
  await page.goto('/')
  const a = node(page, '想要探索的事'),
    b = node(page, '下一步行动'),
    untouched = node(page, '值得记住的事'),
    blue = page.getByRole('button', { name: '旗子 blue', exact: true })
  await expect(page.getByRole('group', { name: '常用图标', exact: true })).toHaveCount(0)
  await a.click()
  await blue.click()
  await expect(favorite(page, '旗子 blue')).toHaveAttribute('title', /已使用 1 次/)
  await blue.click()
  await expect(favorite(page, '旗子 blue')).toHaveAttribute('title', /已使用 1 次/)
  await b.click({ modifiers: ['Alt'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await page.keyboard.press('Meta+]')
  await expect(page.getByLabel('节点属性', { exact: true })).toBeHidden()
  await favorite(page, '旗子 blue').click()
  await expect(favorite(page, '旗子 blue')).toHaveAttribute('title', /已使用 2 次/)
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await expect(a.locator('svg')).toHaveCount(1)
  await expect(b.locator('svg')).toHaveCount(1)
  await expect(untouched.locator('svg')).toHaveCount(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(a.locator('svg')).toHaveCount(0)
  await expect(b.locator('svg')).toHaveCount(0)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  const quick = favorite(page, '旗子 blue')
  await quick.focus()
  await quick.press('Space')
  await expect(quick).toBeFocused()
  await expect(quick).toHaveAttribute('aria-pressed', 'false')
  await expect(quick).toHaveAttribute('title', /已使用 2 次/)
  await quick.press('Enter')
  await expect(quick).toHaveAttribute('aria-pressed', 'true')
  await expect(quick).toHaveAttribute('title', /已使用 3 次/)
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(favorite(page, '旗子 blue')).toHaveAttribute('title', /已使用 3 次/)
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await expect(a.locator('svg')).toHaveCount(1)
  await expect(b.locator('svg')).toHaveCount(1)
  await page.getByLabel('脑图画布', { exact: true }).press('Escape')
  await expect(favorite(page, '旗子 blue')).toBeDisabled()
})

test('常用图标最多五个，次数优先且同次数最近优先，切图刷新保留', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const key = 'mindme.marker-usage.v1'
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          entries: [
            { category: 'flag', value: 'red', count: 5, lastUsed: 1 },
            { category: 'flag', value: 'blue', count: 5, lastUsed: 3 },
            { category: 'priority', value: '①', count: 2, lastUsed: 2 },
            { category: 'progress', value: 'done', count: 1, lastUsed: 4 },
            { category: 'flag', value: 'orange', count: 1, lastUsed: 5 },
            { category: 'flag', value: 'green', count: 1, lastUsed: 6 },
          ],
        }),
      )
  })
  await page.goto('/')
  const group = page.getByRole('group', { name: '常用图标', exact: true })
  const names = () =>
    group
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  const expected = ['旗子 blue', '旗子 red', '优先级 ①', '旗子 green', '旗子 orange'].map(
    (s) => `常用图标：${s}`,
  )
  await expect(group.getByRole('button')).toHaveCount(5)
  expect(await names()).toEqual(expected)
  await node(page, '我的第一个脑图').click()
  await page.getByRole('button', { name: '新建脑图', exact: true }).click()
  // 新建对话框保留空名称时会自动命名。
  await page.getByRole('dialog').getByRole('button', { name: /创建/ }).click()
  expect(await names()).toEqual(expected)
  await page.reload()
  // 刷新后先等本地空间与工具栏恢复，再核对排序，避免在启动页读取空列表。
  await expect(group.getByRole('button')).toHaveCount(5)
  expect(await names()).toEqual(expected)
  await page.screenshot({ path: testInfo.outputPath('常用图标-桌面.png') })
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect(group.getByRole('button')).toHaveCount(5)
  for (const button of await group.getByRole('button').all()) await expect(button).toBeVisible()
  await expect(page.getByRole('button', { name: '收起节点面板', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('常用图标-窄窗口.png') })
})

test('Command 方括号独立切换左右侧栏、保留多选，输入和组合期间不触发', async ({ page }) => {
  await page.goto('/')
  const a = node(page, '想要探索的事'),
    b = node(page, '下一步行动'),
    left = page.getByLabel('脑图列表', { exact: true }),
    right = page.getByLabel('节点属性', { exact: true })
  await a.click()
  await b.click({ modifiers: ['Alt'] })
  await page.keyboard.press('Meta+[')
  await expect(left).toBeHidden()
  await expect(right).toBeVisible()
  await page.keyboard.press('Meta+]')
  await expect(right).toBeHidden()
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await page.keyboard.press('Meta+[')
  await page.keyboard.press('Meta+]')
  await expect(left).toBeVisible()
  await expect(right).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  // 直接模拟输入法和长按事件，确保不切换面板也不阻止原事件。
  const input = page.getByLabel('输入所选节点文字')
  for (const detail of [{ isComposing: true }, { repeat: true }]) {
    const allowed = await input.evaluate(
      (element, detail) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '[',
            code: 'BracketLeft',
            metaKey: true,
            bubbles: true,
            cancelable: true,
            ...detail,
          }),
        ),
      detail,
    )
    expect(allowed).toBe(true)
    await expect(left).toBeVisible()
  }
  const search = page.getByLabel('按名称筛选脑图')
  await search.fill('我的')
  await search.press('Meta+[')
  await expect(left).toBeVisible()
  await expect(search).toHaveValue('我的')
  await b.dblclick()
  const editor = page.getByLabel('编辑节点文字')
  await editor.press('Meta+]')
  await expect(right).toBeVisible()
  await editor.press('Escape')
  await page.getByRole('button', { name: '快捷键', exact: true }).click()
  await expect(
    page.getByRole('dialog').getByText('展开 / 收起左侧脑图列表', { exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(left).toBeVisible()
})
