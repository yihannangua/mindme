import { expect, test, type Page } from '@playwright/test'

const canvas = (page: Page) => page.getByLabel('脑图画布', { exact: true })
const node = (page: Page, text: string) =>
  page.getByRole('button', { name: `节点 ${text}`, exact: true })
const view = (page: Page) =>
  canvas(page)
    .locator('svg.graph > g')
    .evaluate((element) => {
      const matrix = (element as unknown as SVGGraphicsElement).transform.baseVal.consolidate()!
        .matrix
      return { x: matrix.e, y: matrix.f, zoom: matrix.a }
    })
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('mindme.v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<{ space: unknown; outbox: unknown }>((resolve, reject) => {
        const request = db.transaction('metadata').objectStore('metadata').get('snapshot')
        request.onsuccess = () =>
          resolve({ space: request.result.space, outbox: request.result.outbox })
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
}
async function nodeStructure(page: Page) {
  return page.locator('.mind-node').evaluateAll((elements) =>
    elements
      .map((element) => ({
        id: element.getAttribute('data-node-id'),
        parentId: element.getAttribute('data-parent-id'),
        label: element.getAttribute('aria-label'),
      }))
      .sort((a, b) => a.id!.localeCompare(b.id!)),
  )
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
}

test('选中节点后点击画布空白处会取消选中', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await expect(page.locator('.mind-node.selected')).toHaveCount(1)
  await canvas(page).click({ position: { x: 24, y: 220 } })
  await expect(page.locator('.mind-node.selected')).toHaveCount(0)
})

test('分区支持递归拆分、独立脑图范围和拖动分隔线，刷新后恢复', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  await expect(page.getByTestId('workspace-layout').locator('.workspace-pane')).toHaveCount(2)
  await page.getByRole('button', { name: '上下拆分画布', exact: true }).last().click()
  await expect(page.getByTestId('workspace-layout').locator('.workspace-pane')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /当前分区：/ })).toHaveCount(3)
  const divider = page.getByRole('separator').first(),
    before = await divider.boundingBox()
  expect(before).toBeTruthy()
  await page.mouse.move(before!.x + 3, before!.y + 20)
  await page.mouse.down()
  await page.mouse.move(before!.x + 80, before!.y + 20, { steps: 5 })
  await page.mouse.up()
  await page.reload()
  await expect(page.getByTestId('workspace-layout').locator('.workspace-pane')).toHaveCount(3)
})

test('画布右上角拆分按钮复制当前画布，顶部标签只切换当前活动分区', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  await expect(page.getByTestId('workspace-layout').locator('.workspace-pane')).toHaveCount(2)
  const summaries = page.getByRole('button', { name: /当前分区：/ })
  await expect(summaries).toHaveCount(2)
  await expect(summaries.first()).toContainText('整张脑图')
  await expect(summaries.last()).toContainText('整张脑图')
  await summaries.last().click()
  await page.getByRole('tab', { name: '我的第一个脑图', exact: true }).click()
  await expect(summaries.last()).toBeVisible()
})

test('分区内容菜单可清空当前画布，顶部标签可直接填入脑图', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /当前分区：/ }).click()
  await page.getByLabel('替换分区脑图').selectOption('')
  await expect(page.getByText('请选择脑图', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '我的第一个脑图', exact: true }).click()
  await expect(node(page, '想要探索的事')).toBeVisible()
  await expect(page.getByTestId('workspace-layout').locator('.workspace-pane')).toHaveCount(1)
})

test('标签拖到画布后按落点拆分，关闭图标移除当前画布', async ({ page }) => {
  await page.goto('/')
  const tab = page.locator('.tab').first(),
    pane = page.getByTestId('workspace-layout').locator('.workspace-pane').first()
  const paneBox = (await pane.boundingBox())!
  await tab.dragTo(pane, {
    targetPosition: { x: paneBox.width - 10, y: paneBox.height / 2 },
  })
  await expect(pane.locator('.workspace-pane-content')).toBeVisible()
  await expect(page.getByTestId('workspace-layout').locator('.workspace-pane')).toHaveCount(2)
  await expect(page.getByTestId('workspace-layout').locator('.workspace-split.row')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '左右拆分分区' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '上下拆分分区' })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭当前画布' }).last().click()
  await expect(page.getByTestId('workspace-layout').locator('.workspace-pane')).toHaveCount(1)
})

test('收到 drop 事件后等待源标签 dragend 才提交拆分', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const panes = page.getByTestId('workspace-layout').locator('.workspace-pane'),
    tab = page.locator('.tab').first(),
    target = panes.nth(1),
    bounds = (await target.boundingBox())!,
    transfer = await page.evaluateHandle(() => new DataTransfer())
  await tab.dispatchEvent('dragstart', { dataTransfer: transfer })
  await target.dispatchEvent('drop', {
    dataTransfer: transfer,
    clientX: bounds.x + bounds.width - 8,
    clientY: bounds.y + bounds.height / 2,
  })
  await expect(panes).toHaveCount(2)
  await tab.dispatchEvent('dragend')
  await expect(panes).toHaveCount(3)
  await expect(page.getByTestId('workspace-layout').locator('.workspace-split.row')).toHaveCount(2)
})

test('多个画布的标签拖动预览限制在对应画布内', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  await page.getByRole('button', { name: '上下拆分画布', exact: true }).last().click()
  const panes = page.getByTestId('workspace-layout').locator('.workspace-pane'),
    tab = page.locator('.tab').first(),
    transfer = await page.evaluateHandle(() => new DataTransfer())
  await tab.dispatchEvent('dragstart', { dataTransfer: transfer })
  for (const index of [0, 1, 2]) {
    const target = panes.nth(index),
      bounds = (await target.boundingBox())!
    await target.dispatchEvent('dragover', {
      dataTransfer: transfer,
      clientX: bounds.x + bounds.width - 8,
      clientY: bounds.y + bounds.height / 2,
    })
    await expect(target).toHaveClass(/drop-second-row/)
    const preview = await target.evaluate((element) => {
      const style = getComputedStyle(element, '::after')
      return {
        width: Number.parseFloat(style.width),
        paneWidth: element.getBoundingClientRect().width,
      }
    })
    expect(preview.width).toBeLessThan(preview.paneWidth)
  }
  await tab.dispatchEvent('dragend')
})

test('点击分区空白处激活画布，选中边框和顶部标签跟随活动分区', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const panes = page.getByTestId('workspace-layout').locator('.workspace-pane')
  await panes
    .nth(1)
    .locator('.canvas')
    .click({ position: { x: 30, y: 220 } })
  await expect(panes.nth(1)).toHaveClass(/active/)
  await expect(panes.nth(0)).not.toHaveClass(/active/)
  await page.getByRole('tab', { name: '我的第一个脑图', exact: true }).click()
  await expect(panes.nth(1)).toHaveClass(/active/)
})

test('活动画布使用区别色标题框并移除右上角下拉箭头', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.workspace-pane-chevron')).toHaveCount(0)
  const pane = page.getByTestId('workspace-layout').locator('.workspace-pane').first()
  await expect(pane).toHaveClass(/active/)
  await expect(pane.locator('.workspace-pane-header')).toHaveClass(/active/)
  await expect(pane.locator('.workspace-pane-header')).toHaveCSS(
    'background-color',
    'rgb(237, 246, 250)',
  )
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const panes = page.getByTestId('workspace-layout').locator('.workspace-pane')
  await panes
    .nth(1)
    .locator('.canvas')
    .click({ position: { x: 30, y: 220 } })
  await expect(panes.nth(1).locator('.workspace-pane-header')).toHaveClass(/active/)
  await expect(panes.nth(0).locator('.workspace-pane-header')).not.toHaveClass(/active/)
})

test('下钻按钮以选中节点为中心，标题显示面包屑并可返回整张脑图', async ({ page }) => {
  await page.goto('/')
  const source = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await source.click()
  await expect(page.getByRole('button', { name: '下钻', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '下钻', exact: true }).click()
  await expect(source).toBeVisible()
  await expect(page.locator('.workspace-pane-breadcrumbs')).toBeVisible()
  const rootBreadcrumb = page.getByRole('button', { name: '返回到我的第一个脑图', exact: true })
  await expect(rootBreadcrumb).toBeVisible()
  await rootBreadcrumb.click()
  await expect(page.locator('.workspace-pane-breadcrumbs')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /当前分区：.*整张脑图/ })).toBeVisible()
  await page.getByRole('button', { name: '节点 我的第一个脑图', exact: true }).click()
  await expect(page.getByRole('button', { name: '下钻', exact: true })).toBeDisabled()
})

for (const trigger of ['自动布局', '下钻']) {
  test(`${trigger}后切换拆分画布保持各自缩放和平移，刷新后恢复`, async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
    await page.getByRole('button', { name: '上下拆分画布', exact: true }).last().click()
    const panes = page.getByTestId('workspace-layout').locator('.workspace-pane'),
      firstCanvas = panes.nth(0).getByLabel('脑图画布', { exact: true }),
      readView = (index: number) =>
        panes
          .nth(index)
          .locator('svg.graph > g')
          .evaluate((element) => {
            const matrix = (
              element as unknown as SVGGraphicsElement
            ).transform.baseVal.consolidate()!.matrix
            return { x: matrix.e, y: matrix.f, zoom: matrix.a }
          })
    await firstCanvas.click({ position: { x: 24, y: 160 } })
    if (trigger === '下钻') {
      await panes.nth(0).getByRole('button', { name: '适应画布', exact: true }).click()
      await panes.nth(0).getByRole('button', { name: '节点 想要探索的事', exact: true }).click()
    }
    await page.getByRole('button', { name: trigger, exact: true }).click()
    if (trigger === '自动布局')
      await expect(page.getByText('已均衡布局', { exact: true })).toBeVisible()
    else await expect(panes.nth(0).locator('.workspace-pane-breadcrumbs')).toBeVisible()
    const fitted = await readView(0)
    const bounds = (await firstCanvas.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.5)
    await page.mouse.wheel(0, -300)
    await expect.poll(async () => (await readView(0)).zoom).toBeGreaterThan(fitted.zoom)
    await drag(
      page,
      { x: bounds.x + 24, y: bounds.y + 160 },
      { x: bounds.x + 60, y: bounds.y + 195 },
    )
    await page.mouse.up()
    const firstView = await readView(0)
    for (const index of [1, 2]) {
      await panes.nth(index).getByRole('button', { name: '放大', exact: true }).click()
    }
    const secondView = await readView(1),
      thirdView = await readView(2),
      content = await snapshot(page)
    for (const index of [0, 1, 2, 0, 2, 1, 0]) {
      await panes
        .nth(index)
        .locator('.canvas')
        .click({ position: { x: 24, y: 160 } })
      await expect(panes.nth(index)).toHaveClass(/active/)
      expect(await readView(0)).toEqual(firstView)
      expect(await readView(1)).toEqual(secondView)
      expect(await readView(2)).toEqual(thirdView)
    }
    expect(await snapshot(page)).toEqual(content)
    // 在另一个分区主动适应后，前一个分区仍不应收到新请求或被清零。
    await panes
      .nth(1)
      .locator('.canvas')
      .click({ position: { x: 24, y: 160 } })
    await page.getByRole('button', { name: '自动布局', exact: true }).click()
    await expect(page.getByText('已均衡布局', { exact: true })).toBeVisible()
    expect(await readView(0)).toEqual(firstView)
    expect(await readView(2)).toEqual(thirdView)
    const finalSecondView = await readView(1)
    await panes
      .nth(0)
      .locator('.canvas')
      .click({ position: { x: 24, y: 160 } })
    expect(await readView(0)).toEqual(firstView)
    await page.reload()
    await expect(panes).toHaveCount(3)
    await expect.poll(() => readView(0)).toEqual(firstView)
    expect(await readView(1)).toEqual(finalSecondView)
    expect(await readView(2)).toEqual(thirdView)
  })
}

test('滚轮直接按鼠标锚点缩放，无需键盘修饰键', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  const before = await view(page),
    content = await snapshot(page),
    bounds = (await canvas(page).boundingBox())!,
    point = { x: bounds.x + bounds.width * 0.36, y: bounds.y + bounds.height * 0.42 },
    worldBefore = {
      x: (point.x - bounds.x - before.x) / before.zoom,
      y: (point.y - bounds.y - before.y) / before.zoom,
    }
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, -120)
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(before.zoom)
  const zoomed = await view(page)
  expect((point.x - bounds.x - zoomed.x) / zoomed.zoom).toBeCloseTo(worldBefore.x, 0)
  expect((point.y - bounds.y - zoomed.y) / zoomed.zoom).toBeCloseTo(worldBefore.y, 0)
  await expect(node(page, '想要探索的事')).toHaveClass(/selected/)
  expect(await snapshot(page)).toEqual(content)

  const savedView = await view(page)
  await page.reload()
  await expect.poll(() => view(page)).toEqual(savedView)
  await expect(node(page, '想要探索的事')).toHaveClass(/selected/)
})

test('空白处按住左键拖动画布，选择与脑图内容不变；Esc 取消会还原视角', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  const before = await view(page),
    content = await snapshot(page),
    bounds = (await canvas(page).boundingBox())!,
    from = { x: bounds.x + 30, y: bounds.y + 90 },
    to = { x: from.x + 85, y: from.y + 55 }
  await drag(page, from, to)
  await expect(canvas(page)).toHaveClass(/panning/)
  await page.mouse.up()
  await expect(canvas(page)).not.toHaveClass(/panning/)
  const moved = await view(page)
  expect(moved.x).toBeCloseTo(before.x + 85)
  expect(moved.y).toBeCloseTo(before.y + 55)
  expect(moved.zoom).toBe(before.zoom)
  await expect(node(page, '想要探索的事')).toHaveClass(/selected/)
  expect(await page.locator('.mind-node.selected')).toHaveCount(1)
  expect(await snapshot(page)).toEqual(content)

  const cancelFrom = { x: bounds.x + 50, y: bounds.y + 120 }
  await page.mouse.move(cancelFrom.x, cancelFrom.y)
  await page.mouse.down()
  await page.mouse.move(cancelFrom.x + 40, cancelFrom.y + 25, { steps: 4 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await view(page)).toEqual(moved)
  await page.reload()
  await expect.poll(async () => (await view(page)).x).toBe(moved.x)
  await expect.poll(async () => (await view(page)).y).toBe(moved.y)
})

test('滚轮单位换算为缩放，侧栏和文字输入区不改变画布', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  const before = await view(page)
  await canvas(page).dispatchEvent('wheel', { deltaY: -2, deltaMode: 1 })
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(before.zoom)
  const afterLine = await view(page)
  await page
    .getByRole('complementary', { name: '节点属性' })
    .dispatchEvent('wheel', { deltaY: -100 })
  expect(await view(page)).toEqual(afterLine)
  await page.keyboard.press('F2')
  const editor = page.getByLabel('编辑节点文字'),
    beforeEditorWheel = await view(page)
  await editor.dispatchEvent('wheel', { deltaY: -100 })
  expect(await view(page)).toEqual(beforeEditorWheel)
  await editor.press('Escape')
})

test('经典与紧凑风格切换、每张脑图本机持久化且不改动脑图内容', async ({ page }) => {
  await page.goto('/')
  await expect(node(page, '想要探索的事')).toBeVisible()
  const content = await nodeStructure(page),
    currentStyle = page.getByRole('button', { name: '当前画布风格：经典', exact: true })
  const buttonBox = (await currentStyle.boundingBox())!,
    chevronBox = (await page.locator('.canvas-style-chevron').boundingBox())!
  expect(
    Math.abs(chevronBox.y + chevronBox.height / 2 - (buttonBox.y + buttonBox.height / 2)),
  ).toBeLessThan(1)
  await expect(currentStyle).toHaveAttribute('aria-expanded', 'false')
  await currentStyle.click()
  await expect(currentStyle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('listbox', { name: '选择画布风格' })).toBeVisible()
  const compact = page.getByRole('option', { name: '紧凑', exact: true })
  await compact.click()
  await expect(canvas(page)).toHaveAttribute('data-style', 'compact')
  await expect(
    page.getByRole('button', { name: '当前画布风格：紧凑', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.node-underline')).toHaveCount(0)
  await expect(page.locator('.edge').first()).toHaveAttribute('d', / H .* V .* H /)
  await node(page, '想要探索的事').click()
  await page.getByRole('button', { name: '旗子 blue', exact: true }).click()
  const rightMarker = await node(page, '想要探索的事')
    .locator('svg[aria-hidden="true"]')
    .evaluate((element) => {
      const nodeElement = element.closest('.mind-node')!
      return {
        x: Number(element.getAttribute('x')),
        width: Number(nodeElement.querySelector(':scope > rect')!.getAttribute('width')),
      }
    })
  await node(page, '灵感与收集').click()
  await page.getByRole('button', { name: '优先级 ①', exact: true }).click()
  const leftMarker = await node(page, '灵感与收集')
    .locator('svg[aria-hidden="true"]')
    .evaluate((element) => {
      const nodeElement = element.closest('.mind-node')!
      return {
        x: Number(element.getAttribute('x')),
        width: Number(nodeElement.querySelector(':scope > rect')!.getAttribute('width')),
      }
    })
  expect(rightMarker.x).toBe(7)
  expect(leftMarker.x).toBe(7)
  const storedStyle = await page.evaluate(() => {
    const activeMap = localStorage.getItem('mindme.editor.v1.activeMap')
    return JSON.parse(localStorage.getItem(`mindme.editor.v1.map:${activeMap}`)!).style
  })
  expect(storedStyle).toBe('compact')
  expect(await nodeStructure(page)).toEqual(content)
  await page.reload()
  await expect(canvas(page)).toHaveAttribute('data-style', 'compact')
  const compactCurrent = page.getByRole('button', { name: '当前画布风格：紧凑', exact: true })
  await compactCurrent.click()
  await page.getByRole('option', { name: '经典', exact: true }).click()
  await expect(canvas(page)).toHaveAttribute('data-style', 'classic')
  await expect(page.locator('.node-underline')).toHaveCount(0)
  await expect(page.locator('.edge').first()).toHaveAttribute('d', / C /)
  await page.reload()
  await expect(canvas(page)).toHaveAttribute('data-style', 'classic')
  await expect(node(page, '想要探索的事')).toBeVisible()
  expect(await nodeStructure(page)).toEqual(content)
})
