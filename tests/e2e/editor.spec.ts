import { expect, test } from '@playwright/test'
import { makeNode } from '../../src/domain/model'
import type { Backup } from '../../src/importers/backup'
const root = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '节点 我的第一个脑图', exact: true })

test('本地保存未完成时 Tab 新节点已选中，立即空格编辑并保留输入', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  const rootNode = page.getByRole('button', { name: '节点 我的第一个脑图', exact: true })
  await rootNode.click()
  await page.evaluate(async (modulePath) => {
    const { LocalDatabase } = await import(modulePath)
    const save = LocalDatabase.prototype.save
    // 隔离测试页延迟落盘，验证编辑不等待写盘，且保存完成不会抢回选择。
    LocalDatabase.prototype.save = async function (...args: unknown[]) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return save.apply(this, args)
    }
  }, '/src/persistence/database.ts')
  await page.keyboard.press('Tab')
  const added = page.getByRole('button', { name: '节点 新主题', exact: true })
  await expect(added).toHaveClass(/selected/, { timeout: 700 })
  await page.keyboard.press('Space')
  const input = page.getByLabel('编辑节点文字', { exact: true })
  await expect(input).toBeFocused({ timeout: 700 })
  await expect(input).toHaveValue('新主题')
  await input.fill('即时编辑新节点')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '节点 即时编辑新节点', exact: true })).toBeVisible()
  await expect(rootNode).toBeVisible()
  await rootNode.click()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible({ timeout: 12000 })
  await expect(rootNode).toHaveClass(/selected/)
  await page.reload()
  await expect(page.getByRole('button', { name: '节点 即时编辑新节点', exact: true })).toBeVisible()
})
test('画布容器按空格立即编辑，缩放按钮按空格仍激活按钮', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  const canvas = page.getByLabel('脑图画布', { exact: true }),
    zoom = page.getByRole('button', { name: '缩小', exact: true })
  const before = await canvas.locator('.graph > g').getAttribute('transform')
  await zoom.focus()
  await zoom.press('Space')
  await expect(canvas.locator('.graph > g')).not.toHaveAttribute('transform', before!)
  await expect(page.getByLabel('编辑节点文字', { exact: true })).toHaveCount(0)
  // 同一事件轮次直接在容器发空格，覆盖透明输入框还没接到焦点的边界。
  await canvas.evaluate((element) => {
    element.focus()
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    )
  })
  await expect(page.getByLabel('编辑节点文字', { exact: true })).toBeFocused()
  await expect(page.getByLabel('编辑节点文字', { exact: true })).toHaveValue('我的第一个脑图')
})
test('节点编辑、快捷键、标记、折叠、撤销与刷新恢复', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await expect(page.getByLabel('当前版本 v0.1.5', { exact: true })).toBeVisible()
  await root(page).click()
  await page.getByLabel('脑图画布', { exact: true }).press('Tab')
  await page.getByLabel('脑图画布', { exact: true }).focus()
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '节点 新主题', exact: true }).dblclick()
  const input = page.getByLabel('编辑节点文字')
  await expect(input).toBeFocused()
  await input.fill('正式编辑内容')
  await input.press('Enter')
  const node = page.getByRole('button', { name: '节点 正式编辑内容', exact: true })
  await expect(node).toBeVisible()
  await page.getByRole('button', { name: '旗子 blue', exact: true }).click()
  await expect(page.getByRole('button', { name: '旗子 blue', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await node.click()
  await page.getByLabel('脑图画布', { exact: true }).press('Tab')
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '折叠 正式编辑内容', exact: true }).click()
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toBeVisible()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(node).toBeVisible()
  await node.click()
  await expect(page.getByRole('button', { name: '旗子 blue', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  expect(errors).toEqual([])
})
for (const marker of ['优先级 ①', '进度 4/8', '旗子 blue']) {
  test(`鼠标设置标记后回车继续编辑，保留原节点标记：${marker}`, async ({ page }) => {
    await page.goto('/')
    const source = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
      button = page.getByRole('button', { name: marker, exact: true })
    await source.click()
    const sourceId = await source.getAttribute('data-node-id'),
      parentId = await source.getAttribute('data-parent-id')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Enter')
    const sibling = page.getByRole('button', { name: '节点 新主题', exact: true })
    await expect(sibling).toHaveClass(/selected/)
    await expect(sibling).toHaveAttribute('data-parent-id', parentId!)
    await expect(source).toHaveAttribute('data-node-id', sourceId!)
    await expect(source.locator('svg')).toHaveCount(1)
    await expect(page.getByLabel('输入所选节点文字')).toBeFocused()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(sibling).toHaveCount(0)
    await expect(source.locator('svg')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(sibling).toHaveCount(1)
    await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
    await page.reload()
    await source.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(source.locator('svg')).toHaveCount(1)
  })
}

for (const marker of ['优先级 ①', '进度 4/8', '旗子 blue']) {
  test(`多选设置标记统一生效、保留选择、整批撤销及刷新恢复：${marker}`, async ({ page }) => {
    await page.goto('/')
    const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
      b = page.getByRole('button', { name: '节点 下一步行动', exact: true }),
      untouched = page.getByRole('button', { name: '节点 值得记住的事', exact: true }),
      button = page.getByRole('button', { name: marker, exact: true }),
      selection = page.locator('.mind-node.selected')
    await a.click()
    await button.click()
    await expect(a.locator('svg')).toHaveCount(1)
    await b.click()
    await a.click({ modifiers: ['Alt'] })
    await expect(selection).toHaveCount(2)
    // 当前节点已带标记但另一个没有，按钮应表示混合状态，点击统一添加。
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(selection).toHaveCount(2)
    await expect(a.locator('svg')).toHaveCount(1)
    await expect(b.locator('svg')).toHaveCount(1)
    await expect(untouched.locator('svg')).toHaveCount(0)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(a.locator('svg')).toHaveCount(1)
    await expect(b.locator('svg')).toHaveCount(0)
    await expect(selection).toHaveCount(2)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(b.locator('svg')).toHaveCount(1)
    await button.focus()
    await button.press('Space')
    await expect(button).toBeFocused()
    await expect(a.locator('svg')).toHaveCount(0)
    await expect(b.locator('svg')).toHaveCount(0)
    await expect(selection).toHaveCount(2)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(a.locator('svg')).toHaveCount(1)
    await expect(b.locator('svg')).toHaveCount(1)
    await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
    await page.reload()
    await expect(selection).toHaveCount(2)
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(a.locator('svg')).toHaveCount(1)
    await expect(b.locator('svg')).toHaveCount(1)
    await expect(untouched.locator('svg')).toHaveCount(0)
  })
}

test('键盘聚焦标记按钮仍可用回车和空格设置、替换及移除', async ({ page }) => {
  await page.goto('/')
  const source = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    blue = page.getByRole('button', { name: '旗子 blue', exact: true }),
    red = page.getByRole('button', { name: '旗子 red', exact: true })
  await source.click()
  await blue.focus()
  await page.keyboard.press('Enter')
  await expect(blue).toHaveAttribute('aria-pressed', 'true')
  await expect(blue).toBeFocused()
  await red.focus()
  await page.keyboard.press('Space')
  await expect(red).toHaveAttribute('aria-pressed', 'true')
  await expect(blue).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Enter')
  await expect(red).toHaveAttribute('aria-pressed', 'false')
  await expect(red).toBeFocused()
  await expect(page.locator('.mind-node')).toHaveCount(5)
  await expect(source).toHaveClass(/selected/)
})

test('方向键从当前节点连续移动选择，覆盖左右分支、上下边界及直接输入衔接', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  const node = (text: string) => page.getByRole('button', { name: `节点 ${text}`, exact: true })
  const move = async (key: string, text: string) => {
    await page.keyboard.press(key)
    await expect(node(text)).toHaveClass(/selected/)
    await expect(page.getByLabel('输入所选节点文字')).toBeFocused()
  }
  await move('ArrowRight', '想要探索的事')
  await move('ArrowRight', '想要探索的事')
  await move('ArrowDown', '下一步行动')
  await move('ArrowDown', '下一步行动')
  await move('ArrowUp', '想要探索的事')
  await move('ArrowLeft', '我的第一个脑图')
  await move('ArrowLeft', '值得记住的事')
  await move('ArrowDown', '灵感与收集')
  await move('ArrowLeft', '灵感与收集')
  await move('ArrowUp', '值得记住的事')
  await move('ArrowRight', '我的第一个脑图')
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  await expect(page.locator('.mind-node')).toHaveCount(5)
  await page.keyboard.type('Moved selection')
  await expect(page.getByLabel('编辑节点文字')).toHaveValue('Moved selection')
  await page.keyboard.press('Escape')
  await expect(root(page)).toHaveClass(/selected/)
})

test('方向键不选择折叠节点，未选中时不跳转，Option 排序快捷键仍有效', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.mind-node.selected')).toHaveCount(0)
  await root(page).click()
  await page.keyboard.press('ArrowRight')
  const branch = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toHaveClass(
    /selected/,
  )
  await page.keyboard.press('ArrowLeft')
  await expect(branch).toHaveClass(/selected/)
  await page.keyboard.press('ControlOrMeta+/')
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(branch).toHaveClass(/selected/)
  const before = await branch.getAttribute('transform')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(branch).toHaveClass(/selected/)
  await expect(branch).not.toHaveAttribute('transform', before!)
  await page.keyboard.press('Alt+ArrowUp')
  await expect(branch).toHaveAttribute('transform', before!)
  await page.keyboard.press('Shift+ArrowDown')
  await expect(branch).toHaveClass(/selected/)
})

test('Alt 下始终顺时针、Alt 上始终逆时针调整左侧根分支', async ({ page }) => {
  await page.goto('/')
  const branch = page.getByRole('button', { name: '节点 灵感与收集', exact: true }),
    next = page.getByRole('button', { name: '节点 值得记住的事', exact: true }),
    canvas = page.getByLabel('脑图画布', { exact: true })
  await branch.click()
  const before = (await branch.boundingBox())!,
    nextBefore = (await next.boundingBox())!
  expect(before.y).toBeGreaterThan(nextBefore.y)
  await canvas.press('Alt+ArrowDown')
  await expect.poll(async () => (await branch.boundingBox())!.y).toBeLessThan(before.y)
  const top = (await branch.boundingBox())!.y
  await canvas.press('Alt+ArrowDown')
  await expect.poll(async () => (await branch.boundingBox())!.y).toBe(top)
  await canvas.press('Alt+ArrowUp')
  await expect.poll(async () => (await branch.boundingBox())!.y).toBeGreaterThan(top)
})

test('编辑、中文组合及其他输入框内方向键不切换节点，退出编辑后恢复导航', async ({ page }) => {
  await page.goto('/')
  await root(page).dblclick()
  const input = page.getByLabel('编辑节点文字')
  await input.fill('abc')
  await input.press('ArrowLeft')
  expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(2)
  for (const key of ['ArrowRight', 'ArrowUp', 'ArrowDown']) await input.press(key)
  await expect(root(page)).toHaveClass(/selected/)
  await input.dispatchEvent('compositionstart')
  await input.dispatchEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', isComposing: true })
  await expect(root(page)).toHaveClass(/selected/)
  await input.dispatchEvent('compositionend')
  await input.press('Escape')
  const filter = page.getByRole('textbox', { name: '按名称筛选脑图' })
  await filter.fill('我的')
  await filter.press('ArrowDown')
  await expect(root(page)).toHaveClass(/selected/)
  await root(page).click()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('button', { name: '节点 想要探索的事', exact: true })).toHaveClass(
    /selected/,
  )
})

test('方向键可导航至屏幕外节点并自动平移，不改变缩放或节点位置', async ({ page }) => {
  const backup: Backup = {
    format: 'mindme',
    schemaVersion: 1,
    exportedAt: 1000,
    maps: [
      {
        id: 'navigation',
        title: '导航测试',
        rootId: 'root',
        deletedAt: null,
        nodes: {
          root: makeNode('root', null, '导航测试'),
          near: { ...makeNode('near', 'root', '起点'), side: 1 },
          far: { ...makeNode('far', 'near', '屏幕外节点'), position: { x: 3000, y: 0 } },
        },
      },
    ],
    tabs: [{ mapId: 'navigation', open: true, pinned: false, order: 0 }],
  }
  await page.goto('/')
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'JSON 备份', exact: true }).click()
  await page.getByLabel('选择导入文件').setInputFiles({
    name: 'navigation.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect(page.getByText('已恢复 1 张脑图的新副本。', { exact: false })).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  await page.getByRole('button', { name: '节点 起点', exact: true }).click()
  const canvas = page.getByLabel('脑图画布', { exact: true })
  for (let i = 0; i < 8; i++) await page.getByRole('button', { name: '放大', exact: true }).click()
  const far = page.getByRole('button', { name: '节点 屏幕外节点', exact: true })
  await expect(far).toHaveCount(0)
  const transform = await canvas.locator('svg.graph > g').getAttribute('transform')
  await page.keyboard.press('ArrowRight')
  await expect(far).toHaveClass(/selected/)
  const box = (await far.boundingBox())!,
    bounds = (await canvas.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(bounds.x)
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
  expect(box.y).toBeGreaterThanOrEqual(bounds.y)
  expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height)
  const moved = await canvas.locator('svg.graph > g').getAttribute('transform')
  expect(moved).not.toBe(transform)
  expect(moved?.match(/scale\([^)]+\)/)?.[0]).toBe(transform?.match(/scale\([^)]+\)/)?.[0])
  const position = await far.getAttribute('transform')
  await page.keyboard.press('ArrowRight')
  await expect(far).toHaveClass(/selected/)
  await expect(far).toHaveAttribute('transform', position!)
})

test('方向键连续跳过没有可见子节点的父辈分支，双向导航且保持侧向和边界', async ({ page }) => {
  const nodes: Backup['maps'][number]['nodes'] = { root: makeNode('root', null, '空分支导航') }
  for (const side of [1, -1] as const) {
    const prefix = side === 1 ? 'r' : 'l',
      label = side === 1 ? '右' : '左'
    for (let i = 0; i < 5; i++) {
      const id = `${prefix}${i}`
      nodes[id] = { ...makeNode(id, 'root', `${label}${i}`, i + (side === -1 ? 5 : 0)), side }
    }
    nodes[`${prefix}2`].collapsed = true
    for (const i of [0, 2, 4]) {
      const id = `${prefix}-child-${i}`
      nodes[id] = { ...makeNode(id, `${prefix}${i}`, `${label}孩子${i}`), side }
    }
  }
  const backup: Backup = {
    format: 'mindme',
    schemaVersion: 1,
    exportedAt: 1000,
    maps: [{ id: 'empty-nav', title: '空分支导航', rootId: 'root', nodes, deletedAt: null }],
    tabs: [{ mapId: 'empty-nav', open: true, pinned: false, order: 0 }],
  }
  await page.goto('/')
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'JSON 备份', exact: true }).click()
  await page.getByLabel('选择导入文件').setInputFiles({
    name: 'empty-nav.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect(page.getByText('已恢复 1 张脑图的新副本。', { exact: false })).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  const node = (name: string) => page.getByRole('button', { name: `节点 ${name}`, exact: true })
  const positions = await page
    .locator('.mind-node')
    .evaluateAll((items) => items.map((item) => item.getAttribute('transform')))
  for (const [top, bottom] of [
    ['右孩子0', '右孩子4'],
    ['左孩子4', '左孩子0'],
  ]) {
    await node(top).click()
    for (const [key, name] of [
      ['ArrowDown', bottom],
      ['ArrowDown', bottom],
      ['ArrowUp', top],
      ['ArrowUp', top],
    ]) {
      await page.keyboard.press(key)
      await expect(node(name)).toHaveClass(/selected/)
      await expect(page.getByLabel('输入所选节点文字')).toBeFocused()
    }
  }
  await expect(node('右孩子2')).toHaveCount(0)
  await expect(node('左孩子2')).toHaveCount(0)
  expect(
    await page
      .locator('.mind-node')
      .evaluateAll((items) => items.map((item) => item.getAttribute('transform'))),
  ).toEqual(positions)
})

test('节点文字左对齐，输入中增宽换行增高且所有文字留在节点内', async ({ page }, info) => {
  await page.goto('/')
  const node = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await node.click()
  await page.getByRole('button', { name: '旗子 blue', exact: true }).click()
  await node.dblclick()
  const input = page.getByLabel('编辑节点文字'),
    rect = page.locator('.mind-node.selected > rect')
  await input.fill('短')
  const shortWidth = Number(await rect.getAttribute('width'))
  await input.fill('输入中的较长文字')
  expect(Number(await rect.getAttribute('width'))).toBeGreaterThan(shortWidth)
  const oneLineHeight = Number(await rect.getAttribute('height'))
  const text = '这段输入中的中文需要完整显示 English123 WWW 👨‍👩‍👧‍👦 '.repeat(5) + '\n手动换行\n最后一行'
  await input.fill(text)
  await expect(input).toBeFocused()
  expect(Number(await rect.getAttribute('height'))).toBeGreaterThan(oneLineHeight)
  const metrics = await input.evaluate((element: HTMLTextAreaElement) => {
    const object = element.parentElement!,
      rect = object.closest('.mind-node')!.querySelector('rect')!,
      icon = object.closest('.mind-node')!.querySelector(':scope > svg')
    return {
      textAlign: getComputedStyle(element).textAlign,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      x: Number(object.getAttribute('x')),
      width: Number(object.getAttribute('width')),
      nodeWidth: Number(rect.getAttribute('width')),
      hasIcon: !!icon,
    }
  })
  expect(metrics.textAlign).toBe('left')
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  expect(metrics.hasIcon).toBe(true)
  expect(metrics.x).toBeGreaterThan(16)
  expect(metrics.x + metrics.width).toBeLessThan(metrics.nodeWidth)
  await page.screenshot({ path: info.outputPath('节点实时换行.png') })
  await input.press('Enter')
  const label = page.locator('.mind-node.selected .node-label')
  await expect(label).toHaveAttribute('text-anchor', 'start')
  const lines = await label.locator('tspan').evaluateAll((elements) =>
    elements.map((element) => {
      const box = (element as unknown as SVGGraphicsElement).getBBox()
      return { text: element.textContent, x: element.getAttribute('x'), right: box.x + box.width }
    }),
  )
  expect(lines.length).toBeGreaterThan(3)
  expect(lines.map((line) => line.text).join('')).toBe(text.replaceAll('\n', ''))
  expect(new Set(lines.map((line) => line.x)).size).toBe(1)
  const nodeWidth = Number(await rect.getAttribute('width'))
  for (const line of lines) expect(line.right).toBeLessThan(nodeWidth)
})

test('中心节点长单词、中文和末尾空行完整显示，Shift Enter 换行并保存刷新', async ({ page }) => {
  await page.goto('/')
  await root(page).dblclick()
  const input = page.getByLabel('编辑节点文字')
  const text = 'W'.repeat(80) + '\n中文内容'.repeat(4) + '\n'
  await input.fill(text)
  await input.press('Shift+Enter')
  await expect(input).toHaveValue(text + '\n')
  const metrics = await input.evaluate((element: HTMLTextAreaElement) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    align: getComputedStyle(element).textAlign,
  }))
  expect(metrics.align).toBe('left')
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.height + 1)
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1)
  await page.keyboard.insertText('新增末行')
  await input.press('Enter')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  const node = page.locator('.root-node')
  await expect(node.locator('.node-label')).toHaveAttribute('text-anchor', 'start')
  await node.dblclick()
  await expect(input).toHaveValue(text + '\n新增末行')
  const noClip = await input.evaluate(
    (element: HTMLTextAreaElement) => element.scrollHeight <= element.clientHeight + 1,
  )
  expect(noClip).toBe(true)
})

test('输入缩短后节点收缩，取消恢复尺寸，中文组合输入扩展时不丢焦点', async ({ page }) => {
  await page.goto('/')
  const node = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await node.dblclick()
  const rect = node.locator(':scope > rect'),
    input = page.getByLabel('编辑节点文字')
  const original = {
    width: await rect.getAttribute('width'),
    height: await rect.getAttribute('height'),
  }
  await input.dispatchEvent('compositionstart')
  await input.fill('组合输入扩展节点'.repeat(20))
  expect(Number(await rect.getAttribute('height'))).toBeGreaterThan(Number(original.height))
  await expect(input).toBeFocused()
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(input).toBeVisible()
  await input.dispatchEvent('compositionend')
  await input.fill('短')
  await expect(rect).toHaveAttribute('height', '42')
  await input.press('Escape')
  await expect(rect).toHaveAttribute('width', original.width!)
  await expect(rect).toHaveAttribute('height', original.height!)
  await expect(node).toBeVisible()
})

test('刷新恢复当前脑图、平移、缩放和选中节点，各脑图分别记住编辑位置', async ({ page }) => {
  await page.goto('/')
  const canvas = page.getByLabel('脑图画布', { exact: true }),
    graph = canvas.locator('svg.graph > g'),
    firstNode = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  const pan = async (dx: number, dy: number) => {
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + 20, box.y + 80)
    await page.mouse.down()
    await page.mouse.move(box.x + 20 + dx, box.y + 80 + dy, { steps: 5 })
    await page.mouse.up()
  }
  await firstNode.click()
  await page.getByRole('button', { name: '放大', exact: true }).click()
  await pan(90, 45)
  const firstView = await graph.getAttribute('transform')
  await page
    .getByRole('complementary', { name: '脑图列表' })
    .getByRole('button', { name: '新建脑图', exact: true })
    .click()
  await page.getByLabel('脑图名称').fill('刷新恢复测试')
  await page.getByRole('button', { name: '创建脑图', exact: true }).click()
  const secondRoot = page.getByRole('button', { name: '节点 刷新恢复测试', exact: true })
  await secondRoot.click()
  await page.keyboard.press('Tab')
  const selected = page.getByRole('button', { name: '节点 新主题', exact: true })
  await expect(selected).toHaveClass(/selected/)
  await page.getByRole('button', { name: '缩小', exact: true }).click()
  await pan(120, -30)
  await expect(selected).toHaveClass(/selected/)
  const secondView = await graph.getAttribute('transform'),
    selectedId = await selected.getAttribute('data-node-id')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('tab', { name: '刷新恢复测试', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(graph).toHaveAttribute('transform', secondView!)
  await expect(page.locator('.mind-node.selected')).toHaveAttribute('data-node-id', selectedId!)
  await page.getByRole('tab', { name: '我的第一个脑图', exact: true }).click()
  await expect(graph).toHaveAttribute('transform', firstView!)
  await expect(firstNode).toHaveClass(/selected/)
  await page.getByRole('tab', { name: '刷新恢复测试', exact: true }).click()
  await expect(graph).toHaveAttribute('transform', secondView!)
  await expect(selected).toHaveClass(/selected/)
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  await expect(graph).not.toHaveAttribute('transform', secondView!)
  const fitted = await graph.getAttribute('transform')
  await page.reload()
  await expect(graph).toHaveAttribute('transform', fitted!)
  await expect(page.locator('.mind-node.selected')).toHaveAttribute('data-node-id', selectedId!)
})

test('取消选择后刷新保持未选中，失效节点或脑图偏好安全回退', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(root(page)).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(0)
  const active = await page.evaluate(() => localStorage.getItem('mindme.editor.v1.activeMap'))
  expect(active).toBeTruthy()
  await page.evaluate((id) => {
    const key = `mindme.editor.v1.map:${id}`,
      state = JSON.parse(localStorage.getItem(key)!)
    localStorage.setItem(key, JSON.stringify({ ...state, selectedId: 'missing-node' }))
  }, active)
  await page.reload()
  await expect(root(page)).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(0)
  await page.evaluate(() => localStorage.setItem('mindme.editor.v1.activeMap', 'missing-map'))
  await page.reload()
  await expect(page.getByRole('tab', { name: '我的第一个脑图', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(root(page)).toBeVisible()
  await page.getByRole('button', { name: '关闭 我的第一个脑图', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await expect(page.getByText('给想法一个起点')).toBeVisible()
})

test('Shift 范围多选包含头尾、支持反向和连续调整，普通点击恢复单选', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    b = page.getByRole('button', { name: '节点 下一步行动', exact: true }),
    c = page.getByRole('button', { name: '节点 灵感与收集', exact: true }),
    d = page.getByRole('button', { name: '节点 值得记住的事', exact: true }),
    selected = page.locator('.mind-node.selected')
  await a.click()
  await c.click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(4)
  for (const node of [a, b, c, d]) await expect(node).toHaveAttribute('aria-pressed', 'true')
  await expect(root(page)).toHaveAttribute('aria-pressed', 'false')
  await b.click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(2)
  await expect(a).toHaveClass(/selected/)
  await expect(b).toHaveClass(/selected/)
  await c.click()
  await a.click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(4)
  await d.click()
  await expect(selected).toHaveCount(1)
  await expect(d).toHaveClass(/selected/)
  await page.keyboard.press('Escape')
  await b.click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(1)
  await expect(b).toHaveClass(/selected/)
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
})

test('Alt 单击增减不连续选择，可取消全部且不会误入编辑或拖动', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    b = page.getByRole('button', { name: '节点 下一步行动', exact: true }),
    c = page.getByRole('button', { name: '节点 灵感与收集', exact: true }),
    selected = page.locator('.mind-node.selected')
  await expect(page.locator('.mind-node')).toHaveCount(5)
  const transforms = await page
    .locator('.mind-node')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('transform')))
  await a.click()
  await c.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(2)
  await c.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(1)
  await expect(a).toHaveClass(/selected/)
  await b.click({ modifiers: ['Alt'] })
  await a.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(1)
  await expect(b).toHaveClass(/selected/)
  await b.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(0)
  await expect(page.getByLabel('编辑节点文字')).toHaveCount(0)
  const box = (await a.boundingBox())!
  await page.keyboard.down('Alt')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 20, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(selected).toHaveCount(1)
  expect(
    await page
      .locator('.mind-node')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('transform'))),
  ).toEqual(transforms)
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
})

test('Shift 多选仅包括展开的节点，展开分支后范围自动包含子节点', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    b = page.getByRole('button', { name: '节点 下一步行动', exact: true }),
    child = page.getByRole('button', { name: '节点 新主题', exact: true })
  await a.click()
  await page.keyboard.press('Tab')
  await expect(child).toBeVisible()
  await page.getByRole('button', { name: '折叠 想要探索的事', exact: true }).click()
  await expect(child).toHaveCount(0)
  await root(page).click()
  await b.click({ modifiers: ['Shift'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(3)
  await page.getByRole('button', { name: '展开 想要探索的事', exact: true }).click()
  await expect(child).toBeVisible()
  await b.click({ modifiers: ['Shift'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(4)
  await expect(child).toHaveClass(/selected/)
})

test('多选和范围起点刷新后保留，切换脑图分别恢复选择', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    c = page.getByRole('button', { name: '节点 灵感与收集', exact: true }),
    d = page.getByRole('button', { name: '节点 值得记住的事', exact: true }),
    selected = page.locator('.mind-node.selected')
  await a.click()
  await d.click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(3)
  const ids = await selected.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-node-id')),
  )
  await page.reload()
  await expect(selected).toHaveCount(3)
  expect(
    await selected.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id'))),
  ).toEqual(ids)
  await c.click({ modifiers: ['Shift'] })
  await expect(selected).toHaveCount(4)
  await page
    .getByRole('complementary', { name: '脑图列表' })
    .getByRole('button', { name: '新建脑图', exact: true })
    .click()
  await page.getByLabel('脑图名称').fill('多选测试')
  await page.getByRole('button', { name: '创建脑图', exact: true }).click()
  const second = page.getByRole('button', { name: '节点 多选测试', exact: true })
  await second.click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toBeVisible()
  await second.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(2)
  await page.getByRole('tab', { name: '我的第一个脑图', exact: true }).click()
  await expect(selected).toHaveCount(4)
  await page.getByRole('tab', { name: '多选测试', exact: true }).click()
  await expect(selected).toHaveCount(2)
})

test('多选后编辑收为当前节点，输入光标和方向导航保持可用', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    b = page.getByRole('button', { name: '节点 下一步行动', exact: true }),
    selected = page.locator('.mind-node.selected')
  await a.click()
  await b.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(2)
  await expect(page.getByText('已选 2 个节点', { exact: true })).toBeVisible()
  await page.keyboard.type('Typing')
  const input = page.getByLabel('编辑节点文字')
  await expect(input).toHaveValue('Typing')
  await expect(selected).toHaveCount(1)
  await expect(b).toHaveClass(/selected/)
  await input.press('Escape')
  await a.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(2)
  await page.keyboard.press('ArrowLeft')
  await expect(selected).toHaveCount(1)
  await expect(root(page)).toHaveClass(/selected/)
  await a.click({ modifiers: ['Alt'] })
  await expect(selected).toHaveCount(2)
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(input).toHaveValue('想要探索的事')
  await expect(selected).toHaveCount(1)
  await input.press('ArrowLeft')
  await expect(a).toHaveClass(/selected/)
  await input.press('Escape')
})

test('自动布局均衡整张脑图、清除手动位置，保留多选和折叠，可撤销重做及刷新恢复', async ({
  page,
}) => {
  const nodes: Backup['maps'][number]['nodes'] = {
    root: { ...makeNode('root', null, '自动布局测试'), position: { x: 300, y: 120 } },
  }
  for (const [i, count] of [6, 3, 0, 0].entries()) {
    const id = `branch-${i}`
    nodes[id] = {
      ...makeNode(id, 'root', `布局分支${i}`, i),
      side: 1,
      position: { x: 120 * (i + 1), y: i * 10 },
    }
    for (let j = 0; j < count; j++)
      nodes[`${id}-${j}`] = {
        ...makeNode(`${id}-${j}`, id, `子主题${i}-${j}`, j),
        side: 1,
        position: { x: 30, y: 10 },
      }
  }
  nodes['branch-2'].collapsed = true
  nodes.hidden = { ...makeNode('hidden', 'branch-2', '隐藏主题'), position: { x: 300, y: 100 } }
  const backup: Backup = {
    format: 'mindme',
    schemaVersion: 1,
    exportedAt: 1000,
    maps: [{ id: 'balance', title: '自动布局测试', rootId: 'root', nodes, deletedAt: null }],
    tabs: [{ mapId: 'balance', open: true, pinned: false, order: 0 }],
  }
  await page.goto('/')
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'JSON 备份', exact: true }).click()
  await page.getByLabel('选择导入文件').setInputFiles({
    name: 'balance.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect(page.getByText('已恢复 1 张脑图的新副本。', { exact: false })).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  const center = page.getByRole('button', { name: '节点 自动布局测试', exact: true }),
    last = page.getByRole('button', { name: '节点 布局分支3', exact: true }),
    button = page.getByRole('button', { name: '自动布局', exact: true })
  await center.click()
  await last.click({ modifiers: ['Alt'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  const originalRoot = await center.getAttribute('transform'),
    originalLast = await last.getAttribute('transform')
  await button.click()
  await expect(page.getByText('已均衡布局', { exact: true })).toBeVisible()
  await expect(center).not.toHaveAttribute('transform', originalRoot!)
  await expect(last).not.toHaveAttribute('transform', originalLast!)
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '节点 隐藏主题', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '展开 布局分支2', exact: true })).toBeVisible()
  const rootX = await center.evaluate(
    (element) =>
      (element as unknown as SVGGraphicsElement).transform.baseVal.getItem(0).matrix.e +
      Number(element.querySelector('rect')!.getAttribute('width')) / 2,
  )
  expect(rootX).toBe(0)
  const arrangedOrder = await page
    .locator('.mind-node')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-node-id')))
  for (const [i, side] of [1, -1, -1, -1].entries()) {
    const x = await page
      .getByRole('button', { name: `节点 布局分支${i}`, exact: true })
      .evaluate(
        (element) =>
          (element as unknown as SVGGraphicsElement).transform.baseVal.getItem(0).matrix.e +
          Number(element.querySelector('rect')!.getAttribute('width')) / 2,
      )
    expect(Math.sign(x)).toBe(side)
  }
  expect(
    await page
      .locator('.mind-node')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-node-id'))),
  ).toEqual(arrangedOrder)
  const arrangedRoot = await center.getAttribute('transform'),
    arrangedLast = await last.getAttribute('transform')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(center).toHaveAttribute('transform', originalRoot!)
  await expect(last).toHaveAttribute('transform', originalLast!)
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(center).toHaveAttribute('transform', arrangedRoot!)
  await expect(last).toHaveAttribute('transform', arrangedLast!)
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(center).toHaveAttribute('transform', arrangedRoot!)
  await expect(last).toHaveAttribute('transform', arrangedLast!)
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
})

test('未选节点也可自动布局，已平衡时保持顺序和位置，空画布时按钮禁用', async ({ page }) => {
  await page.goto('/')
  const branch = page.getByRole('button', { name: '节点 下一步行动', exact: true }),
    button = page.getByRole('button', { name: '自动布局', exact: true })
  await expect(branch).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(0)
  const before = await branch.getAttribute('transform'),
    orderBefore = await page
      .locator('.mind-node')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-node-id')))
  await button.click()
  await expect(page.getByText('已均衡布局', { exact: true })).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(0)
  const after = await branch.getAttribute('transform')
  expect(after).toBe(before)
  expect(
    await page
      .locator('.mind-node')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-node-id'))),
  ).toEqual(orderBefore)
  await button.click()
  await expect(branch).toHaveAttribute('transform', after!)
  await page.getByRole('button', { name: '关闭 我的第一个脑图', exact: true }).click()
  await expect(button).toBeDisabled()
})

test('下钻后自动布局不改变子节点显示顺序', async ({ page }) => {
  const nodes: Backup['maps'][number]['nodes'] = {
    root: makeNode('root', null, '下钻顺序测试'),
    heavy: { ...makeNode('heavy', 'root', '较重分支', 0), side: 1 },
    scope: { ...makeNode('scope', 'root', '下钻节点', 1), side: -1 },
    a: { ...makeNode('a', 'scope', '第一项', 0), side: 1 },
    b: { ...makeNode('b', 'scope', '第二项', 1), side: -1 },
    c: { ...makeNode('c', 'scope', '第三项', 2), side: 1 },
  }
  for (let index = 0; index < 8; index++)
    nodes[`heavy-${index}`] = {
      ...makeNode(`heavy-${index}`, 'heavy', `较重分支子项${index}`, index),
      side: 1,
    }
  const backup: Backup = {
    format: 'mindme',
    schemaVersion: 1,
    exportedAt: 1000,
    maps: [{ id: 'drill-order', title: '下钻顺序测试', rootId: 'root', nodes, deletedAt: null }],
    tabs: [{ mapId: 'drill-order', open: true, pinned: false, order: 0 }],
  }
  await page.goto('/')
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'JSON 备份', exact: true }).click()
  await page.getByLabel('选择导入文件').setInputFiles({
    name: 'drill-order.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect(page.getByText('已恢复 1 张脑图的新副本。', { exact: false })).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  const scopeNode = page.getByRole('button', { name: '节点 下钻节点', exact: true })
  const scopeId = await scopeNode.getAttribute('data-node-id')
  await scopeNode.click()
  await page.getByRole('button', { name: '下钻', exact: true }).click()
  await expect(page.getByRole('button', { name: '节点 第一项', exact: true })).toBeVisible()
  const before = await page
    .locator('.mind-node')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-node-id')))
  await page.getByRole('button', { name: '自动布局', exact: true }).click()
  await expect(page.getByText('已均衡布局', { exact: true })).toBeVisible()
  const after = await page
    .locator('.mind-node')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-node-id')))
  expect(after).toEqual(before)
  expect(
    await page
      .getByRole('button', { name: '节点 第一项', exact: true })
      .getAttribute('data-parent-id'),
  ).toBe(scopeId)
  expect(
    await page
      .getByRole('button', { name: '节点 第二项', exact: true })
      .getAttribute('data-parent-id'),
  ).toBe(scopeId)
  expect(
    await page
      .getByRole('button', { name: '节点 第三项', exact: true })
      .getAttribute('data-parent-id'),
  ).toBe(scopeId)
})

async function openBatchDragMap(page: import('@playwright/test').Page) {
  const nodes: Backup['maps'][number]['nodes'] = {
    root: makeNode('root', null, '批量拖拽测试'),
    a: { ...makeNode('a', 'root', '分支甲', 0), side: 1 },
    b: { ...makeNode('b', 'root', '分支乙', 1), side: 1 },
    target: { ...makeNode('target', 'root', '挂接目标', 2), side: -1, collapsed: true },
    child: { ...makeNode('child', 'a', '甲的孩子'), side: 1, markers: { flag: 'blue' } },
    grandchild: { ...makeNode('grandchild', 'child', '甲的孙节点'), side: 1 },
    existing: { ...makeNode('existing', 'target', '目标原有孩子'), side: -1 },
  }
  const backup: Backup = {
    format: 'mindme',
    schemaVersion: 1,
    exportedAt: 1000,
    maps: [{ id: 'batch-drag', title: '批量拖拽测试', rootId: 'root', nodes, deletedAt: null }],
    tabs: [{ mapId: 'batch-drag', open: true, pinned: false, order: 0 }],
  }
  await page.goto('/')
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'JSON 备份', exact: true }).click()
  await page.getByLabel('选择导入文件').setInputFiles({
    name: 'batch-drag.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect(page.getByText('已恢复 1 张脑图的新副本。', { exact: false })).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  const node = (name: string) => page.getByRole('button', { name: `节点 ${name}`, exact: true })
  await expect(node('甲的孙节点')).toBeVisible()
  const startDrag = async (from: string, to: string) => {
    const source = (await node(from).boundingBox())!,
      destination = (await node(to).boundingBox())!
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(
      destination.x + destination.width / 2,
      destination.y + destination.height / 2,
      { steps: 12 },
    )
  }
  return { node, startDrag }
}

test('多选从任一已选节点批量拖拽，所有后代同步预览，挂接一次撤销重做并刷新恢复', async ({
  page,
}) => {
  const { node, startDrag } = await openBatchDragMap(page)
  await page.getByRole('button', { name: '展开 挂接目标', exact: true }).click()
  await node('分支甲').click()
  await node('分支乙').click({ modifiers: ['Alt'] })
  const names = ['分支甲', '分支乙', '甲的孩子', '甲的孙节点'],
    transforms = await Promise.all(names.map((name) => node(name).getAttribute('transform'))),
    rootId = await node('批量拖拽测试').getAttribute('data-node-id'),
    targetId = await node('挂接目标').getAttribute('data-node-id')
  await startDrag('分支甲', '挂接目标')
  await expect(page.getByText(/松手后将 2 个分支挂接到「挂接目标」/)).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  for (const [i, name] of names.entries())
    await expect(node(name)).not.toHaveAttribute('transform', transforms[i]!)
  await expect(node('挂接目标')).toHaveClass(/drop-target/)
  await page.mouse.up()
  await expect(node('分支甲')).toHaveAttribute('data-parent-id', targetId!)
  await expect(node('分支乙')).toHaveAttribute('data-parent-id', targetId!)
  await expect(node('目标原有孩子')).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  const aId = await node('分支甲').getAttribute('data-node-id'),
    childId = await node('甲的孩子').getAttribute('data-node-id')
  await expect(node('甲的孩子')).toHaveAttribute('data-parent-id', aId!)
  await expect(node('甲的孙节点')).toHaveAttribute('data-parent-id', childId!)
  await expect(node('甲的孩子').locator('svg')).toHaveCount(1)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(node('分支甲')).toHaveAttribute('data-parent-id', rootId!)
  await expect(node('分支乙')).toHaveAttribute('data-parent-id', rootId!)
  await expect(node('目标原有孩子')).toBeVisible()
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(node('分支甲')).toHaveAttribute('data-parent-id', targetId!)
  await expect(node('分支乙')).toHaveAttribute('data-parent-id', targetId!)
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(node('分支甲')).toHaveAttribute('data-parent-id', targetId!)
  await expect(node('分支乙')).toHaveAttribute('data-parent-id', targetId!)
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
})

for (const batch of [false, true]) {
  test(`拖拽挂接保留目标折叠：${batch ? '多选' : '单选'}，撤销重做和刷新后展开查看`, async ({
    page,
  }) => {
    const { node, startDrag } = await openBatchDragMap(page)
    const expand = page.getByRole('button', { name: '展开 挂接目标', exact: true }),
      targetId = (await node('挂接目标').getAttribute('data-node-id'))!,
      aId = (await node('分支甲').getAttribute('data-node-id'))!,
      childId = (await node('甲的孩子').getAttribute('data-node-id'))!
    await node('分支甲').click()
    if (batch) await node('分支乙').click({ modifiers: ['Alt'] })
    await startDrag('分支甲', '挂接目标')
    await expect(page.locator('.attach-hint')).toBeVisible()
    await page.mouse.up()
    await expect(expand).toBeVisible()
    await expect(node('分支甲')).toHaveCount(0)
    await expect(node('目标原有孩子')).toHaveCount(0)
    if (batch) await expect(node('分支乙')).toHaveCount(0)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(node('分支甲')).toBeVisible()
    await expect(node('甲的孩子')).toBeVisible()
    await expect(expand).toBeVisible()
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(node('分支甲')).toHaveCount(0)
    await expect(expand).toBeVisible()
    await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
    await page.reload()
    await expect(expand).toBeVisible()
    await expect(node('分支甲')).toHaveCount(0)
    await expand.click()
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect(node('分支甲')).toHaveAttribute('data-parent-id', targetId)
    if (batch) await expect(node('分支乙')).toHaveAttribute('data-parent-id', targetId)
    await expect(node('目标原有孩子')).toBeVisible()
    await expect(node('甲的孩子')).toHaveAttribute('data-parent-id', aId)
    await expect(node('甲的孙节点')).toHaveAttribute('data-parent-id', childId)
    await node('甲的孩子').click()
    await expect(page.getByRole('button', { name: '旗子 blue', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
}

test('Shift 父子同时多选时整批挂接仅移动外层分支，不拆散子树', async ({ page }) => {
  const { node, startDrag } = await openBatchDragMap(page)
  await page.getByRole('button', { name: '展开 挂接目标', exact: true }).click()
  await node('分支甲').click()
  await node('分支乙').click({ modifiers: ['Shift'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(4)
  const aId = await node('分支甲').getAttribute('data-node-id'),
    childId = await node('甲的孩子').getAttribute('data-node-id'),
    targetId = await node('挂接目标').getAttribute('data-node-id')
  await startDrag('甲的孩子', '挂接目标')
  await expect(page.getByText(/松手后将 2 个分支挂接/)).toBeVisible()
  await page.mouse.up()
  await expect(node('分支甲')).toHaveAttribute('data-parent-id', targetId!)
  await expect(node('分支乙')).toHaveAttribute('data-parent-id', targetId!)
  await expect(node('甲的孩子')).toHaveAttribute('data-parent-id', aId!)
  await expect(node('甲的孙节点')).toHaveAttribute('data-parent-id', childId!)
  await expect(page.locator('.mind-node.selected')).toHaveCount(4)
})

test('批量拖拽到自身或后代、空白处及 Esc 取消都不改结构或位置，普通点击仍恢复单选', async ({
  page,
}) => {
  const { node, startDrag } = await openBatchDragMap(page)
  await node('分支甲').click()
  await node('分支乙').click({ modifiers: ['Alt'] })
  const aParent = await node('分支甲').getAttribute('data-parent-id'),
    aTransform = await node('分支甲').getAttribute('transform'),
    bTransform = await node('分支乙').getAttribute('transform')
  await startDrag('分支乙', '甲的孙节点')
  await expect(page.locator('.attach-hint')).toHaveCount(0)
  await page.mouse.up()
  await expect(node('分支甲')).toHaveAttribute('transform', aTransform!)
  await expect(node('分支乙')).toHaveAttribute('transform', bTransform!)
  const canvas = (await page.getByLabel('脑图画布', { exact: true }).boundingBox())!,
    a = (await node('分支甲').boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(canvas.x + 50, canvas.y + 100, { steps: 10 })
  await page.mouse.up()
  await expect(node('分支甲')).toHaveAttribute('transform', aTransform!)
  await expect(node('分支乙')).toHaveAttribute('transform', bTransform!)
  await startDrag('分支甲', '挂接目标')
  await expect(page.locator('.attach-hint')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.attach-hint')).toHaveCount(0)
  await expect(node('分支甲')).toHaveAttribute('data-parent-id', aParent!)
  await expect(node('分支甲')).toHaveAttribute('transform', aTransform!)
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await node('分支甲').click()
  await expect(page.locator('.mind-node.selected')).toHaveCount(1)
})

test('中心节点参与多选时禁止批量拖拽，缩放后仍可批量挂到中心节点', async ({ page }) => {
  const { node, startDrag } = await openBatchDragMap(page)
  await node('批量拖拽测试').click()
  await node('分支甲').click({ modifiers: ['Alt'] })
  await startDrag('分支甲', '挂接目标')
  await page.mouse.up()
  await expect(
    page.getByText('中心主题不能参与批量挂接，请先取消中心主题的选择', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await expect(node('分支甲')).toHaveAttribute(
    'data-parent-id',
    (await node('批量拖拽测试').getAttribute('data-node-id'))!,
  )
  await node('甲的孩子').click()
  await node('分支乙').click({ modifiers: ['Alt'] })
  await page.getByRole('button', { name: '缩小', exact: true }).click()
  await startDrag('分支乙', '批量拖拽测试')
  await expect(page.locator('.attach-hint')).toBeVisible()
  await page.mouse.up()
  const rootId = await node('批量拖拽测试').getAttribute('data-node-id')
  await expect(node('甲的孩子')).toHaveAttribute('data-parent-id', rootId!)
  await expect(node('分支乙')).toHaveAttribute('data-parent-id', rootId!)
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
})

test('中文组合输入不触发新增，取消编辑恢复原文', async ({ page }) => {
  await page.goto('/')
  await root(page).dblclick()
  const input = page.getByLabel('编辑节点文字')
  await input.dispatchEvent('compositionstart')
  await input.fill('中文组合中')
  await input.press('Enter')
  await expect(input).toBeVisible()
  await input.dispatchEvent('compositionend')
  await input.press('Escape')
  await expect(root(page)).toBeVisible()
  await expect(page.getByRole('button', { name: '节点 中文组合中', exact: true })).toHaveCount(0)
})
test('选中节点直接输入保留首字符、连续输入和标点，可撤销重做并刷新恢复', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  await page.getByLabel('脑图画布', { exact: true }).press('Tab')
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toBeVisible()
  await page.keyboard.type('Hello, 123!')
  const input = page.getByLabel('编辑节点文字')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Hello, 123!')
  await input.press('Enter')
  const node = page.getByRole('button', { name: '节点 Hello, 123!', exact: true })
  await expect(node).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(node).toBeVisible()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(node).toBeVisible()
})

test('直接输入可取消，F2 保留原文编辑，单字符草稿刷新后可恢复', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  await page.keyboard.type('Cancel')
  const input = page.getByLabel('编辑节点文字')
  await expect(input).toHaveValue('Cancel')
  await input.press('Escape')
  await expect(root(page)).toBeVisible()
  await page.keyboard.press('F2')
  await expect(input).toHaveValue('我的第一个脑图')
  await input.press('Escape')
  await page.keyboard.type('X')
  await expect(input).toHaveValue('X')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '节点 X', exact: true })).toBeVisible()
})

test('选中节点按空格进入编辑模式并保留原内容', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  await page.keyboard.press('Space')
  const input = page.getByLabel('编辑节点文字')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('我的第一个脑图')
  await input.press('Escape')
  await expect(root(page)).toBeVisible()
})

test('选中节点直接中文组合输入，确认候选时不新增节点或提前保存', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  const capture = page.getByLabel('输入所选节点文字')
  await expect(capture).toBeFocused()
  await capture.dispatchEvent('compositionstart')
  const input = page.getByLabel('编辑节点文字')
  await input.fill('中文输入')
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true })
  await expect(input).toBeFocused()
  await expect(root(page)).toBeVisible()
  await expect(page.getByRole('button', { name: '节点 新主题', exact: true })).toHaveCount(0)
  await input.dispatchEvent('compositionend')
  await page.keyboard.insertText('完成')
  await expect(input).toHaveValue('中文输入完成')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '节点 中文输入完成', exact: true })).toBeVisible()
})

test('浏览器原生中文组合输入可从选中状态直接开始并提交', async ({ page, browserName }) => {
  test.skip(
    browserName !== 'chromium',
    '原生组合输入使用 Chromium CDP；其他浏览器执行组合事件回归。',
  )
  await page.goto('/')
  await root(page).click()
  const session = await page.context().newCDPSession(page)
  await session.send('Input.imeSetComposition', {
    text: '中文',
    selectionStart: 2,
    selectionEnd: 2,
  })
  const input = page.getByLabel('编辑节点文字')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('中文')
  await session.send('Input.insertText', { text: '中文' })
  await page.keyboard.type(' IME')
  await expect(input).toHaveValue('中文 IME')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '节点 中文 IME', exact: true })).toBeVisible()
  await session.detach()
})

test('未选中时输入不改节点，其他输入框正常输入，选中态仍可粘贴分支', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  await page.keyboard.press('Escape')
  await page.keyboard.type('ignored')
  await expect(page.getByLabel('编辑节点文字')).toHaveCount(0)
  await expect(root(page)).toBeVisible()
  await page
    .getByRole('complementary', { name: '脑图列表' })
    .getByRole('button', { name: '新建脑图', exact: true })
    .click()
  await page.getByLabel('脑图名称').pressSequentially('Other input')
  await expect(page.getByLabel('脑图名称')).toHaveValue('Other input')
  await page.getByLabel('关闭对话框').click()
  await root(page).click()
  const copied = await page.getByLabel('输入所选节点文字').evaluate((element) => {
    const clipboardData = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }),
    )
    return clipboardData.getData('text/plain')
  })
  expect(copied).toContain('我的第一个脑图')
  await page.getByLabel('输入所选节点文字').evaluate((element) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', '- 粘贴子节点')
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    )
  })
  await expect(page.getByRole('button', { name: '节点 粘贴子节点', exact: true })).toBeVisible()
  await expect(root(page)).toBeVisible()
  await expect(page.getByLabel('编辑节点文字')).toHaveCount(0)
})

test('大纲导入插入与新建、损坏 JSON 失败不改数据', async ({ page }) => {
  await page.goto('/')
  await root(page).click()
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByLabel('导入大纲').fill('# 新分支\n- 叶子')
  await page.getByRole('button', { name: '导入大纲', exact: true }).click()
  await expect(page.getByText('已导入 1 张内容。', { exact: false })).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  await expect(page.getByRole('button', { name: '节点 新分支', exact: true })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(1)
  await page.getByLabel('脑图画布', { exact: true }).press('Escape')
  await page.getByLabel('脑图画布', { exact: true }).click({ position: { x: 8, y: 8 } })
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByLabel('导入大纲').fill('# 独立脑图\n- 子节点')
  await page.getByRole('button', { name: '导入大纲', exact: true }).click()
  await page.getByLabel('关闭对话框').click()
  await expect(page.getByRole('tab')).toHaveCount(2)
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'JSON 备份', exact: true }).click()
  await page
    .getByLabel('选择导入文件')
    .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{') })
  await expect(page.getByRole('alert')).toContainText('格式损坏')
  await page.getByLabel('关闭对话框').click()
  await expect(page.getByRole('tab')).toHaveCount(2)
})
test('重命名、标签关闭、回收站恢复与永久删除确认', async ({ page }) => {
  await page.goto('/')
  await expect(root(page)).toBeVisible()
  await page
    .getByRole('complementary', { name: '脑图列表' })
    .getByRole('button', { name: '新建脑图', exact: true })
    .click()
  await page.getByLabel('脑图名称').fill('第二张脑图')
  await page.getByRole('button', { name: '创建脑图', exact: true }).click()
  await expect(page.getByRole('tab')).toHaveCount(2)
  await page.getByRole('button', { name: '关闭 第二张脑图', exact: true }).click()
  await expect(page.getByRole('tab')).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('tab')).toHaveCount(1)
  await page
    .getByRole('navigation', { name: '' })
    .getByRole('button', { name: '第二张脑图' })
    .click()
  await expect(page.getByRole('tab')).toHaveCount(2)
  await page.getByRole('button', { name: '•••', exact: true }).click()
  await page.getByRole('button', { name: '移入回收站', exact: true }).click()
  await expect(page.getByRole('tab')).toHaveCount(1)
  await page
    .getByRole('complementary', { name: '脑图列表' })
    .getByRole('button', { name: /^回收站/ })
    .click()
  await page.getByRole('button', { name: '恢复', exact: true }).click()
  await expect(page.getByText('回收站是空的')).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  await expect(page.getByRole('tab', { name: '第二张脑图' })).toBeVisible()
  await page.getByRole('button', { name: '•••', exact: true }).click()
  await page.getByRole('button', { name: '移入回收站', exact: true }).click()
  await page
    .getByRole('complementary', { name: '脑图列表' })
    .getByRole('button', { name: /^回收站/ })
    .click()
  await page.getByRole('button', { name: '永久删除', exact: true }).click()
  await expect(page.getByRole('button', { name: '确认永久删除', exact: true })).toBeDisabled()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: '确认永久删除', exact: true }).click()
  await expect(page.getByText('回收站是空的')).toBeVisible()
})
test('断网修改、刷新和备份下载', async ({ page, context }) => {
  await page.goto('/')
  await root(page).dblclick()
  const input = page.getByLabel('编辑节点文字')
  await context.setOffline(true)
  await input.fill('离线也能保存')
  await input.press('Enter')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByRole('button', { name: '节点 离线也能保存', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前脑图', exact: true }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toContain('.json')
  expect(await download.failure()).toBeNull()
})
test('保存历史后预览恢复，并保留恢复前内容', async ({ page }) => {
  await page.goto('/')
  await root(page).dblclick()
  await page.getByLabel('编辑节点文字').fill('版本一')
  await page.getByLabel('编辑节点文字').press('Enter')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '节点 版本一', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '节点 版本一', exact: true }).dblclick()
  await page.getByLabel('编辑节点文字').fill('版本二')
  await page.getByLabel('编辑节点文字').press('Enter')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  await page.getByRole('button', { name: '查看并恢复', exact: true }).first().click()
  await page.getByRole('button', { name: '确认恢复此版本', exact: true }).click()
  await expect(page.getByRole('button', { name: '节点 版本一', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  await expect(page.getByText(/版本二 · .*恢复前保护版本/)).toBeVisible()
})

test('输入中刷新可恢复草稿，取消后不会恢复取消的文字', async ({ page }) => {
  await page.goto('/')
  await root(page).dblclick()
  await page.getByLabel('编辑节点文字').fill('未按回车的草稿')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '节点 未按回车的草稿', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '节点 未按回车的草稿', exact: true }).dblclick()
  await page.getByLabel('编辑节点文字').fill('取消的草稿')
  await page.getByLabel('编辑节点文字').press('Escape')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: '节点 未按回车的草稿', exact: true })).toBeVisible()
})
test('节点普通拖动不改父级，挂接提示后松手改变父级，滚轮直接缩放', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    b = page.getByRole('button', { name: '节点 下一步行动', exact: true })
  const before = await a.boundingBox()
  expect(before).not.toBeNull()
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2)
  await page.mouse.down()
  await page.mouse.move(before!.x + before!.width / 2 + 55, before!.y + before!.height / 2 + 10, {
    steps: 6,
  })
  await page.mouse.up()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  const moved = await a.boundingBox()
  expect(moved!.x).toBeGreaterThan(before!.x + 40)
  const end = await b.boundingBox()
  await page.mouse.move(moved!.x + moved!.width / 2, moved!.y + moved!.height / 2)
  await page.mouse.down()
  await page.mouse.move(end!.x + end!.width / 2, end!.y + end!.height / 2, { steps: 12 })
  await expect(page.getByText('松手后挂接到「下一步行动」')).toBeVisible()
  await page.mouse.up()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await b.click()
  await page.getByRole('button', { name: '折叠 下一步行动', exact: true }).click()
  await expect(a).toHaveCount(0)
  await page.getByRole('button', { name: '展开 下一步行动', exact: true }).click()
  await expect(a).toBeVisible()
  const canvas = page.getByLabel('脑图画布', { exact: true }),
    area = await canvas.boundingBox()
  await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2)
  const transform = await page.locator('.graph>g').getAttribute('transform')
  await page.mouse.wheel(0, -100)
  await expect(page.locator('.graph>g')).not.toHaveAttribute('transform', transform!)
})
test('XMind 8 实际文件选择导入多图与未知标记报告', async ({ page }) => {
  const { zipSync, strToU8 } = await import('fflate')
  const xml =
    '<xmap-content><sheet><topic id="a"><title>文件脑图甲</title><children><topics type="attached"><topic id="b"><title>文件子主题</title><markers><marker-ref marker-id="flag-blue"/><marker-ref marker-id="unsupported"/></markers></topic></topics></children></topic></sheet><sheet><topic id="c"><title>文件脑图乙</title></topic></sheet></xmap-content>'
  await page.goto('/')
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'XMind 8 文件', exact: true }).click()
  await page.getByLabel('选择导入文件').setInputFiles({
    name: 'generated.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(zipSync({ 'content.xml': strToU8(xml) })),
  })
  await expect(page.getByText(/已导入 2 张内容.*unsupported/)).toBeVisible()
  await page.getByLabel('关闭对话框').click()
  await expect(page.getByRole('tab')).toHaveCount(3)
  await page.getByRole('tab', { name: '文件脑图甲', exact: true }).click()
  await page.getByRole('button', { name: '节点 文件子主题', exact: true }).click()
  await expect(page.getByRole('button', { name: '旗子 blue', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})

test('画布结构剪贴板保留层级和标记，文字编辑区粘贴不创建节点', async ({ page }) => {
  await page.goto('/')
  const branch = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await branch.click()
  await page.getByRole('button', { name: '旗子 blue', exact: true }).click()
  const clipboard = await page.getByLabel('脑图画布', { exact: true }).evaluate((element) => {
    const data = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    return {
      text: data.getData('text/plain'),
      branch: data.getData('application/x-mindme-branch+json'),
    }
  })
  expect(clipboard.branch).toContain('blue')
  await root(page).click()
  await page.getByLabel('脑图画布', { exact: true }).evaluate((element, clipboard) => {
    const data = new DataTransfer()
    data.setData('text/plain', clipboard.text)
    data.setData('application/x-mindme-branch+json', clipboard.branch)
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, clipboard)
  await expect(branch).toHaveCount(2)
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await root(page).dblclick()
  await page.getByLabel('编辑节点文字').evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/plain', '# 仅文字')
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  })
  await expect(branch).toHaveCount(2)
})

for (const mode of ['单分支', '多分支', '纯文本', '面板按钮'] as const) {
  test(`粘贴到已折叠节点保持折叠：${mode}，撤销重做及刷新后可展开查看`, async ({ page }) => {
    const { node } = await openBatchDragMap(page)
    const canvas = page.getByLabel('脑图画布', { exact: true }),
      expand = page.getByRole('button', { name: '展开 挂接目标', exact: true })
    await node('分支甲').click()
    if (mode === '多分支') await node('分支乙').click({ modifiers: ['Alt'] })
    const clipboard = await canvas.evaluate((element) => {
      const data = new DataTransfer()
      element.dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
      )
      return Object.fromEntries(Array.from(data.types).map((type) => [type, data.getData(type)]))
    })
    await node('挂接目标').click()
    const targetId = (await node('挂接目标').getAttribute('data-node-id'))!,
      visibleBefore = await page.locator('.mind-node').count()
    await expect(expand).toBeVisible()
    await page.getByRole('button', { name: '缩小', exact: true }).click()
    const viewBefore = await canvas.locator('.graph > g').getAttribute('transform')
    if (mode === '面板按钮') {
      await page.evaluate((text) => {
        Object.defineProperty(navigator.clipboard, 'readText', {
          configurable: true,
          value: async () => text,
        })
      }, clipboard['text/plain'])
      await page.getByRole('button', { name: '粘贴内容', exact: true }).click()
    } else {
      await canvas.evaluate(
        (element, value) => {
          const data = new DataTransfer()
          if (value.plain) data.setData('text/plain', '# 粘贴的新分支\n- 粘贴的后代')
          else for (const [type, text] of Object.entries(value.clipboard)) data.setData(type, text)
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          )
        },
        { clipboard, plain: mode === '纯文本' },
      )
    }
    await expect(
      page.getByText(
        mode === '纯文本'
          ? /剪贴板仅提供纯文字/
          : mode === '面板按钮'
            ? '已粘贴内容'
            : '已粘贴分支',
        { exact: false },
      ),
    ).toBeVisible()
    await expect(expand).toBeVisible()
    await expect(page.locator('.mind-node')).toHaveCount(visibleBefore)
    await expect(node('目标原有孩子')).toHaveCount(0)
    await expect(node('挂接目标')).toHaveClass(/selected/)
    await expect(canvas.locator('.graph > g')).toHaveAttribute('transform', viewBefore!)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(expand).toBeVisible()
    await expect(page.locator('.mind-node')).toHaveCount(visibleBefore)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(expand).toBeVisible()
    await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
    await page.reload()
    await expect(expand).toBeVisible()
    await expect(canvas.locator('.graph > g')).toHaveAttribute('transform', viewBefore!)
    await expect(page.locator('.mind-node')).toHaveCount(visibleBefore)
    await expand.click()
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect(node('目标原有孩子')).toBeVisible()
    const directChildren = page.locator(`.mind-node[data-parent-id="${targetId}"]`)
    await expect(directChildren).toHaveCount(mode === '多分支' ? 3 : 2)
    if (mode === '纯文本') {
      await expect(node('粘贴的新分支')).toBeVisible()
      await expect(node('粘贴的后代')).toBeVisible()
    } else {
      const pastedA = directChildren.filter({ has: page.locator('text', { hasText: '分支甲' }) }),
        pastedId = (await pastedA.getAttribute('data-node-id'))!
      await expect(pastedA).toBeVisible()
      const pastedChild = page.locator(`.mind-node[data-parent-id="${pastedId}"]`)
      await expect(pastedChild).toHaveAttribute('aria-label', '节点 甲的孩子')
      await pastedChild.click()
      await expect(page.getByRole('button', { name: '旗子 blue', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    }
  })
}

for (const multiple of [false, true]) {
  test(`剪切${multiple ? '多个' : '单个'}分支到折叠节点，缩放和平移在粘贴、撤销重做及刷新后保持`, async ({
    page,
  }) => {
    const { node } = await openBatchDragMap(page)
    const canvas = page.getByLabel('脑图画布', { exact: true })
    await node('分支甲').click()
    if (multiple) await node('分支乙').click({ modifiers: ['Alt'] })
    const clipboard = await canvas.evaluate((element) => {
      const data = new DataTransfer()
      element.dispatchEvent(
        new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
      )
      return Object.fromEntries(Array.from(data.types).map((type) => [type, data.getData(type)]))
    })
    await expect(node('分支甲')).toHaveCount(0)
    if (multiple) await expect(node('分支乙')).toHaveCount(0)
    await expect(page.getByText('已剪切分支', { exact: true })).toBeVisible()
    await node('挂接目标').click()
    const targetId = (await node('挂接目标').getAttribute('data-node-id'))!
    await page.getByRole('button', { name: '缩小', exact: true }).click()
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 100)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 45, box.y + 125, { steps: 5 })
    await page.mouse.up()
    // 平移空白画布不改变当前目标选择。
    await node('挂接目标').click()
    const view = (await canvas.locator('.graph > g').getAttribute('transform'))!
    await canvas.evaluate((element, clipboard) => {
      const data = new DataTransfer()
      for (const [type, text] of Object.entries(clipboard)) data.setData(type, text)
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    }, clipboard)
    await expect(page.getByText('已粘贴分支', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '展开 挂接目标', exact: true })).toBeVisible()
    await expect(canvas.locator('.graph > g')).toHaveAttribute('transform', view)
    await expect(node('分支甲')).toHaveCount(0)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(canvas.locator('.graph > g')).toHaveAttribute('transform', view)
    await page.getByRole('button', { name: '重做', exact: true }).click()
    await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
    await expect(canvas.locator('.graph > g')).toHaveAttribute('transform', view)
    await page.reload()
    await expect(page.getByRole('button', { name: '展开 挂接目标', exact: true })).toBeVisible()
    await expect(canvas.locator('.graph > g')).toHaveAttribute('transform', view)
    await page.getByRole('button', { name: '展开 挂接目标', exact: true }).click()
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect(node('分支甲')).toHaveAttribute('data-parent-id', targetId)
    if (multiple) await expect(node('分支乙')).toHaveAttribute('data-parent-id', targetId)
    await expect(node('甲的孩子')).toBeVisible()
    await expect(node('甲的孙节点')).toBeVisible()
    await expect(node('目标原有孩子')).toBeVisible()
  })
}

test('剪切快捷键复制结构化分支并删除，撤销可恢复', async ({ page }) => {
  await page.goto('/')
  const branch = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await branch.click()
  await page.keyboard.press('ControlOrMeta+x')
  await expect(branch).toHaveCount(0)
  await expect(page.getByText('已剪切分支', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByRole('button', { name: '节点 想要探索的事', exact: true })).toBeVisible()
})

test('剪切事件写入分支结构和纯文本剪贴板，中心主题受保护', async ({ page }) => {
  await page.goto('/')
  const branch = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await branch.click()
  const clipboard = await page.getByLabel('脑图画布', { exact: true }).evaluate((element) => {
    const data = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    return {
      text: data.getData('text/plain'),
      branch: data.getData('application/x-mindme-branch+json'),
    }
  })
  expect(clipboard.text).toContain('想要探索的事')
  expect(clipboard.branch).toContain('想要探索的事')
  await expect(branch).toHaveCount(0)
  await page.getByRole('button', { name: '节点 我的第一个脑图', exact: true }).click()
  await page.getByLabel('脑图画布', { exact: true }).evaluate((element) => {
    const data = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  })
  await expect(page.getByText('中心主题不能剪切', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '节点 我的第一个脑图', exact: true })).toBeVisible()
})

test('多选复制全部所选分支并可粘贴', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    b = page.getByRole('button', { name: '节点 下一步行动', exact: true })
  await a.click()
  await b.click({ modifiers: ['Alt'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  const clipboard = await page.getByLabel('脑图画布', { exact: true }).evaluate((element) => {
    const data = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    return {
      text: data.getData('text/plain'),
      branches: data.getData('application/x-mindme-branches+json'),
    }
  })
  expect(clipboard.text).toContain('想要探索的事')
  expect(clipboard.text).toContain('下一步行动')
  expect(JSON.parse(clipboard.branches).drafts).toHaveLength(2)
  await page.getByLabel('脑图画布', { exact: true }).evaluate((element, value) => {
    const data = new DataTransfer()
    data.setData('application/x-mindme-branches+json', value.branches)
    data.setData('text/plain', value.text)
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, clipboard)
  await expect(a).toHaveCount(2)
  await expect(b).toHaveCount(2)
})

test('多选剪切删除全部所选分支并可撤销', async ({ page }) => {
  await page.goto('/')
  const a = page.getByRole('button', { name: '节点 想要探索的事', exact: true }),
    b = page.getByRole('button', { name: '节点 下一步行动', exact: true })
  await a.click()
  await b.click({ modifiers: ['Alt'] })
  await page.keyboard.press('ControlOrMeta+x')
  await expect(a).toHaveCount(0)
  await expect(b).toHaveCount(0)
  await expect(page.getByText('已剪切分支', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(a).toHaveCount(1)
  await expect(b).toHaveCount(1)

  await a.click()
  await b.click({ modifiers: ['Alt'] })
  await page.keyboard.press('Delete')
  await expect(a).toHaveCount(0)
  await expect(b).toHaveCount(0)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(a).toHaveCount(1)
  await expect(b).toHaveCount(1)
})

test('同一浏览器第二页面受写锁保护，关闭首个页面后可接管', async ({ page, context }) => {
  await page.goto('/')
  await expect(root(page)).toBeVisible()
  const second = await context.newPage()
  await second.goto('/')
  await expect(second.getByText('脑图已在另一个页面打开')).toBeVisible()
  await page.close()
  await second.getByRole('button', { name: '重新打开', exact: true }).click()
  await expect(root(second)).toBeVisible()
})

test('本地空间归属账号不匹配时在请求前暂停并显示备份入口', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mindme.v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('metadata', 'readwrite'),
        metadata = transaction.objectStore('metadata'),
        request = metadata.get('snapshot')
      request.onsuccess = () => {
        const snapshot = request.result
        snapshot.ownerSub = 'previous-account'
        metadata.put(snapshot, 'snapshot')
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  })

  let syncRequests = 0
  await page.route('**/auth/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        configured: true,
        subject: 'current-account',
        csrf: 'test-csrf',
        serverTime: Date.now(),
      }),
    }),
  )
  await page.route('**/api/sync', (route) => {
    syncRequests++
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schemaVersion: 1,
        seq: 1,
        space: null,
        baseSeq: 0,
        changes: [],
        results: [],
        serverTime: Date.now(),
        subject: 'current-account',
      }),
    })
  })
  await page.reload()
  await expect(page.getByRole('button', { name: '本地账号不匹配', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('旧浏览器配置仍保留更完整的本地数据')
  await expect(page.getByRole('button', { name: '重试同步', exact: true })).toBeDisabled()
  expect(syncRequests).toBe(0)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载全空间 JSON 备份', exact: true }).click()
  expect((await download).suggestedFilename()).toContain('全空间')
  expect(syncRequests).toBe(0)
})
