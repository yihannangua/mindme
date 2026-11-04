import { expect, test, type Page } from '@playwright/test'

const panes = (page: Page) => page.getByTestId('workspace-layout').locator('.workspace-pane')
const node = (pane: ReturnType<typeof panes>, text: string) =>
  pane.getByRole('button', { name: `节点 ${text}`, exact: true })
const workspaceState = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('mindme.workspace.v1')!))
const paneView = (page: Page, paneId: string) =>
  page.evaluate((id) => {
    const workspace = JSON.parse(localStorage.getItem('mindme.workspace.v1')!)
    const mapId = workspace.panes[id].mapId
    return JSON.parse(localStorage.getItem(`mindme.editor.v1.map:pane:${id}:${mapId}`)!).view
  }, paneId)
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
async function dragDivider(page: Page, name: string, dx: number, dy: number) {
  const divider = page.getByRole('separator', { name, exact: true }),
    box = (await divider.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 })
  await page.mouse.up()
}

test('左右及上下分隔线可持续拖动，尺寸与布局刷新后保留', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  const before = await snapshot(page)
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const row = page.getByRole('separator', { name: '左右分区大小', exact: true })
  await expect(row).toHaveAttribute('aria-valuenow', '50')
  const original = (await panes(page).first().boundingBox())!.width
  await dragDivider(page, '左右分区大小', 130, 0)
  await expect
    .poll(async () => (await panes(page).first().boundingBox())!.width)
    .toBeGreaterThan(original + 90)
  const rowValue = Number(await row.getAttribute('aria-valuenow'))
  expect(rowValue).toBeGreaterThan(50)
  await panes(page).last().getByRole('button', { name: '上下拆分画布', exact: true }).click()
  const column = page.getByRole('separator', { name: '上下分区大小', exact: true })
  await expect(column).toHaveAttribute('aria-valuenow', '50')
  await dragDivider(page, '上下分区大小', 0, -70)
  const columnValue = Number(await column.getAttribute('aria-valuenow'))
  expect(columnValue).toBeLessThan(50)
  await expect(row).toHaveAttribute('aria-valuenow', String(rowValue))
  const bounds = await page
    .locator('.workspace-split.row')
    .first()
    .evaluate((el) => {
      const parent = el.getBoundingClientRect(),
        children = Array.from(el.children).map((item) => item.getBoundingClientRect())
      return { parentRight: parent.right, lastRight: children.at(-1)!.right }
    })
  expect(bounds.lastRight).toBeLessThanOrEqual(bounds.parentRight + 1)
  const layout = (await workspaceState(page)).root
  expect(await snapshot(page)).toEqual(before)
  await page.reload()
  await expect(panes(page)).toHaveCount(3)
  await expect(row).toHaveAttribute('aria-valuenow', String(rowValue))
  await expect(column).toHaveAttribute('aria-valuenow', String(columnValue))
  expect((await workspaceState(page)).root).toEqual(layout)
})

test('分隔线支持键盘调整与上下限，取消拖动后不继续响应', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const divider = page.getByRole('separator', { name: '左右分区大小', exact: true })
  await divider.focus()
  await page.keyboard.press('ArrowRight')
  await expect(divider).toHaveAttribute('aria-valuenow', '52')
  await page.keyboard.press('Home')
  await expect(divider).toHaveAttribute('aria-valuenow', '15')
  await page.keyboard.press('End')
  await expect(divider).toHaveAttribute('aria-valuenow', '85')
  await page.keyboard.press('Home')
  const box = (await divider.boundingBox())!
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2
  await divider.dispatchEvent('pointerdown', {
    pointerId: 77,
    isPrimary: true,
    button: 0,
    clientX: x,
    clientY: y,
  })
  await page.evaluate(
    ({ x, y }) =>
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 77,
          isPrimary: true,
          clientX: x + 80,
          clientY: y,
        }),
      ),
    { x, y },
  )
  await expect
    .poll(async () => Number(await divider.getAttribute('aria-valuenow')))
    .toBeGreaterThan(15)
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 77, isPrimary: true })),
  )
  const stopped = await divider.getAttribute('aria-valuenow')
  await page.evaluate(
    ({ x, y }) =>
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 77,
          isPrimary: true,
          clientX: x + 180,
          clientY: y,
        }),
      ),
    { x, y },
  )
  await expect(divider).toHaveAttribute('aria-valuenow', stopped!)
  await page.reload()
  await expect(divider).toHaveAttribute('aria-valuenow', stopped!)
})

test('拖动画布把手交换嵌套分区，保留选择、视角和数据', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  await panes(page).last().getByRole('button', { name: '上下拆分画布', exact: true }).click()
  await expect(panes(page)).toHaveCount(3)
  await node(panes(page).nth(1), '下一步行动').click()
  await node(panes(page).nth(0), '想要探索的事').click()
  const first = (await panes(page).nth(0).getAttribute('data-pane-id'))!,
    third = (await panes(page).nth(2).getAttribute('data-pane-id'))!,
    before = await snapshot(page)
  await panes(page).nth(0).getByLabel('脑图画布').hover()
  await page.mouse.wheel(0, -180)
  await expect.poll(async () => (await paneView(page, first)).zoom).toBeGreaterThan(1)
  await panes(page).nth(2).getByLabel('脑图画布').hover()
  await page.mouse.wheel(0, -340)
  await expect.poll(async () => (await paneView(page, third)).zoom).toBeGreaterThan(1)
  const oldView = await paneView(page, first)
  const thirdView = await paneView(page, third)
  await panes(page)
    .nth(0)
    .getByRole('button', { name: '拖动画布调整位置' })
    .dragTo(panes(page).nth(2))
  await expect(panes(page).nth(0)).toHaveAttribute('data-pane-id', third)
  await expect(panes(page).nth(2)).toHaveAttribute('data-pane-id', first)
  await expect(node(panes(page).nth(2), '想要探索的事')).toHaveClass(/selected/)
  await expect(node(panes(page).nth(1), '下一步行动')).toHaveClass(/selected/)
  await expect.poll(() => paneView(page, first)).toEqual(oldView)
  await expect.poll(() => paneView(page, third)).toEqual(thirdView)
  expect(await snapshot(page)).toEqual(before)
  await page.reload()
  await expect(panes(page).nth(0)).toHaveAttribute('data-pane-id', third)
  await expect(panes(page).nth(2)).toHaveAttribute('data-pane-id', first)
  await expect(node(panes(page).nth(2), '想要探索的事')).toHaveClass(/selected/)
  await expect.poll(() => paneView(page, first)).toEqual(oldView)
  await expect.poll(() => paneView(page, third)).toEqual(thirdView)
})

test('把手可用方向键交换画布位置并保持把手焦点', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const first = (await panes(page).first().getAttribute('data-pane-id'))!,
    second = (await panes(page).last().getAttribute('data-pane-id'))!
  await panes(page).first().getByRole('button', { name: '拖动画布调整位置' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', second)
  await expect(panes(page).last()).toHaveAttribute('data-pane-id', first)
  await expect(panes(page).last().getByRole('button', { name: '拖动画布调整位置' })).toBeFocused()
})

test('单个分区全屏和退出后保留布局、选择、视角及脑图数据', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  await node(panes(page).last(), '下一步行动').click()
  const paneId = (await panes(page).last().getAttribute('data-pane-id'))!,
    target = page.locator(`[data-pane-id="${paneId}"]`),
    before = await snapshot(page),
    layout = (await workspaceState(page)).root,
    view = await paneView(page, paneId)
  await target.getByRole('button', { name: '全屏显示当前画布', exact: true }).click()
  await expect(target.getByRole('button', { name: '退出画布全屏', exact: true })).toBeVisible()
  const fullscreen = await target.evaluate((el) => ({
    native: document.fullscreenElement === el,
    fallback: el.classList.contains('viewport-fullscreen'),
    width: el.getBoundingClientRect().width,
    height: el.getBoundingClientRect().height,
  }))
  expect(fullscreen.native || fullscreen.fallback).toBe(true)
  expect(fullscreen.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 2)
  expect(fullscreen.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 2)
  await expect(target.getByRole('button', { name: '左右拆分画布' })).toHaveCount(0)
  await expect(node(target, '下一步行动')).toHaveClass(/selected/)
  await expect(target.getByLabel('输入所选节点文字')).toBeFocused()
  await target.getByRole('button', { name: '退出画布全屏', exact: true }).click()
  await expect(target.getByRole('button', { name: '全屏显示当前画布', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  expect((await workspaceState(page)).root).toEqual(layout)
  await expect.poll(() => paneView(page, paneId)).toEqual(view)
  expect(await snapshot(page)).toEqual(before)
  await page.reload()
  await expect(panes(page)).toHaveCount(2)
  await expect(node(page.locator(`[data-pane-id="${paneId}"]`), '下一步行动')).toHaveClass(
    /selected/,
  )
})

test('系统退出全屏事件能同步按钮状态', async ({ page }) => {
  await page.goto('/')
  const pane = panes(page).first()
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  await expect(pane.getByRole('button', { name: '退出画布全屏' })).toBeVisible()
  if (await page.evaluate(() => !!document.fullscreenElement))
    await page.evaluate(() => document.exitFullscreen())
  else await page.keyboard.press('Escape')
  await expect(pane.getByRole('button', { name: '全屏显示当前画布' })).toBeVisible()
})

test('浏览器不支持系统全屏时窗口内放大，Esc 优先取消文字编辑', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true }),
  )
  await page.goto('/')
  const pane = panes(page).first()
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  await expect(pane).toHaveClass(/viewport-fullscreen/)
  await expect(pane.getByText('窗口内全屏', { exact: true })).toBeVisible()
  await expect(pane.getByRole('button', { name: '退出画布全屏' })).toBeVisible()
  await node(pane, '想要探索的事').click()
  await page.keyboard.press('Space')
  await expect(page.getByLabel('编辑节点文字')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('编辑节点文字')).toHaveCount(0)
  await expect(pane).toHaveClass(/viewport-fullscreen/)
  await page.keyboard.press('Escape')
  await expect(pane).not.toHaveClass(/viewport-fullscreen/)
  await expect(pane.getByRole('button', { name: '全屏显示当前画布' })).toBeVisible()
})

test('系统全屏被拒绝时仍可通过窗口内全屏及按钮退出', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      value: () => Promise.reject(new Error('denied')),
      configurable: true,
    })
  })
  await page.goto('/')
  const pane = panes(page).first()
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  await expect(pane).toHaveClass(/viewport-fullscreen/)
  await pane.getByRole('button', { name: '退出画布全屏' }).click()
  await expect(pane).not.toHaveClass(/viewport-fullscreen/)
})

test('窗口内全屏拖动画布时 Esc 先取消拖动，不丢失选择或退出全屏', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(document, 'fullscreenEnabled', { value: false, configurable: true }),
  )
  await page.goto('/')
  const pane = panes(page).first(),
    canvas = pane.getByLabel('脑图画布', { exact: true })
  await node(pane, '想要探索的事').click()
  const graph = canvas.locator('svg.graph > g'),
    beforeFullscreen = await graph.getAttribute('transform')
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  await expect(pane).toHaveClass(/viewport-fullscreen/)
  await expect(graph).not.toHaveAttribute('transform', beforeFullscreen!)
  const original = await graph.getAttribute('transform'),
    rect = (await canvas.boundingBox())!
  await page.mouse.move(rect.x + 32, rect.y + rect.height - 32)
  await page.mouse.down()
  await page.mouse.move(rect.x + 112, rect.y + rect.height - 82, { steps: 5 })
  await expect(graph).not.toHaveAttribute('transform', original!)
  await page.keyboard.press('Escape')
  await expect(graph).toHaveAttribute('transform', original!)
  await expect(pane).toHaveClass(/viewport-fullscreen/)
  await expect(node(pane, '想要探索的事')).toHaveClass(/selected/)
  await page.mouse.up()
  await page.keyboard.press('Escape')
  await expect(pane).not.toHaveClass(/viewport-fullscreen/)
  await expect(node(pane, '想要探索的事')).toHaveClass(/selected/)
})

test('画布拖放在源拖动结束前不重排，取消拖动不会改变布局', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const first = (await panes(page).first().getAttribute('data-pane-id'))!,
    second = (await panes(page).last().getAttribute('data-pane-id'))!,
    grip = panes(page).first().getByRole('button', { name: '拖动画布调整位置' }),
    transfer = await page.evaluateHandle(() => new DataTransfer())
  await grip.dispatchEvent('dragstart', { dataTransfer: transfer })
  await panes(page).last().dispatchEvent('dragover', { dataTransfer: transfer })
  await expect(panes(page).last()).toHaveClass(/drop-swap/)
  await panes(page).last().dispatchEvent('drop', { dataTransfer: transfer })
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', first)
  await expect(panes(page).last()).toHaveAttribute('data-pane-id', second)
  await grip.dispatchEvent('dragend', { dataTransfer: transfer })
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', second)
  await expect(panes(page).last()).toHaveAttribute('data-pane-id', first)
  const cancelGrip = panes(page).first().getByRole('button', { name: '拖动画布调整位置' }),
    cancelled = await page.evaluateHandle(() => new DataTransfer())
  await cancelGrip.dispatchEvent('dragstart', { dataTransfer: cancelled })
  await cancelGrip.dispatchEvent('dragend', { dataTransfer: cancelled })
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', second)
  await expect(panes(page).last()).toHaveAttribute('data-pane-id', first)
})

test('文字编辑时进入全屏不会丢失待保存内容', async ({ page }) => {
  await page.goto('/')
  const pane = panes(page).first()
  await node(pane, '想要探索的事').dblclick()
  const input = page.getByLabel('编辑节点文字', { exact: true })
  await input.fill('全屏前的待保存文字')
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  await expect(pane.getByRole('button', { name: '退出画布全屏' })).toBeVisible()
  await expect(node(pane, '全屏前的待保存文字')).toHaveClass(/selected/)
  await pane.getByRole('button', { name: '退出画布全屏' }).click()
  await expect(page.locator('header.top').getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(node(panes(page).first(), '全屏前的待保存文字')).toBeVisible()
})

test('Esc 退出当前画布全屏并保留节点选择', async ({ page }) => {
  await page.goto('/')
  const pane = panes(page).first()
  await node(pane, '想要探索的事').click()
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  await expect(pane.getByRole('button', { name: '退出画布全屏' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pane.getByRole('button', { name: '全屏显示当前画布' })).toBeVisible()
  await expect(node(pane, '想要探索的事')).toHaveClass(/selected/)
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
})

test('触控拖动画布把手可交换位置，取消时不改变布局', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const first = (await panes(page).first().getAttribute('data-pane-id'))!,
    second = (await panes(page).last().getAttribute('data-pane-id'))!,
    grip = panes(page).first().getByRole('button', { name: '拖动画布调整位置' }),
    from = (await grip.boundingBox())!,
    to = (await panes(page).last().boundingBox())!,
    x = from.x + from.width / 2,
    y = from.y + from.height / 2,
    tx = to.x + to.width / 2,
    ty = to.y + to.height / 2
  const start = (id: number) =>
    grip.dispatchEvent('pointerdown', {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
    })
  const move = (id: number) =>
    page.evaluate(
      ({ id, tx, ty }) =>
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: id,
            pointerType: 'touch',
            isPrimary: true,
            clientX: tx,
            clientY: ty,
            cancelable: true,
          }),
        ),
      { id, tx, ty },
    )
  await start(91)
  await move(91)
  await expect(panes(page).last()).toHaveClass(/drop-swap/)
  await page.evaluate(() =>
    window.dispatchEvent(
      new PointerEvent('pointercancel', { pointerId: 91, pointerType: 'touch', isPrimary: true }),
    ),
  )
  await expect(panes(page).last()).not.toHaveClass(/drop-swap/)
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', first)
  await start(92)
  await move(92)
  await expect(panes(page).last()).toHaveClass(/drop-swap/)
  await page.evaluate(() =>
    window.dispatchEvent(
      new PointerEvent('pointerup', { pointerId: 92, pointerType: 'touch', isPrimary: true }),
    ),
  )
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', second)
  await expect(panes(page).last()).toHaveAttribute('data-pane-id', first)
  await page.reload()
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', second)
})

test('窄屏分区全屏后退出按钮保持可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const target = panes(page).last()
  await target.getByRole('button', { name: '全屏显示当前画布' }).click()
  const exit = target.getByRole('button', { name: '退出画布全屏' })
  await expect(exit).toBeVisible()
  const box = (await exit.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await exit.click()
  await expect(panes(page)).toHaveCount(2)
})

test('其他拖放不会误触分区重排或触发浏览器默认处理', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const before = (await workspaceState(page)).root
  const prevented = await panes(page)
    .first()
    .evaluate((element) => {
      const transfer = new DataTransfer()
      transfer.setData('text/plain', '外部测试文字')
      const event = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
  expect(prevented).toBe(true)
  expect((await workspaceState(page)).root).toEqual(before)
})

test('全屏显示本地保存失败并可重试，不丢失正在编辑的文字', async ({ page }) => {
  await page.goto('/')
  const pane = panes(page).first()
  await node(pane, '想要探索的事').click()
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  await expect(pane.getByText('本地已保存', { exact: true })).toBeVisible()
  await expect(pane.getByLabel('输入所选节点文字', { exact: true })).toBeFocused()
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    let fail = true
    ;(window as unknown as { restoreTestPut: () => void }).restoreTestPut = () => {
      IDBObjectStore.prototype.put = original
    }
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (fail && this.name === 'metadata' && args[1] === 'snapshot') {
        fail = false
        this.transaction.abort()
        throw new DOMException('测试本地空间不足', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  await page.keyboard.type('保存失败待恢复')
  const input = page.getByLabel('编辑节点文字', { exact: true })
  await expect(input).toHaveValue('保存失败待恢复')
  await expect(pane.getByRole('alert')).toContainText('本地未保存')
  await page.evaluate(() => (window as unknown as { restoreTestPut: () => void }).restoreTestPut())
  await pane.getByRole('button', { name: '重试保存', exact: true }).click()
  await expect(pane.getByText('本地已保存', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('保存失败待恢复')
  await input.press('Enter')
  await expect(node(pane, '保存失败待恢复')).toBeVisible()
  await pane.getByRole('button', { name: '退出画布全屏' }).click()
  await page.reload()
  await expect(node(panes(page).first(), '保存失败待恢复')).toBeVisible()
})

test('全屏内可看到画布操作提示并关闭', async ({ page }) => {
  await page.goto('/')
  const pane = panes(page).first()
  await node(pane, '想要探索的事').click()
  await pane.getByRole('button', { name: '全屏显示当前画布' }).click()
  const input = pane.getByLabel('输入所选节点文字')
  await expect(input).toBeFocused()
  await input.evaluate((element) => {
    const clipboardData = new DataTransfer()
    element.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData }),
    )
  })
  const toast = pane.locator('.workspace-fullscreen-toast')
  await expect(toast).toContainText('已复制分支')
  await toast.getByRole('button', { name: '关闭提示' }).click()
  await expect(toast).toHaveCount(0)
})

test('拖动画布交换位置前的文字编辑可保存并在刷新后恢复', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const first = (await panes(page).first().getAttribute('data-pane-id'))!
  await node(panes(page).first(), '想要探索的事').dblclick()
  await page.getByLabel('编辑节点文字').fill('拖动之前的编辑文字')
  await panes(page)
    .first()
    .getByRole('button', { name: '拖动画布调整位置' })
    .dragTo(panes(page).last())
  await expect(panes(page).last()).toHaveAttribute('data-pane-id', first)
  await expect(node(panes(page).last(), '拖动之前的编辑文字')).toBeVisible()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(node(panes(page).last(), '拖动之前的编辑文字')).toBeVisible()
})

test('本地保存失败时不交换画布，恢复保存后文字仍可找回', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const first = (await panes(page).first().getAttribute('data-pane-id'))!,
    second = (await panes(page).last().getAttribute('data-pane-id'))!
  await node(panes(page).first(), '想要探索的事').dblclick()
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    ;(window as unknown as { restoreTestPut: () => void }).restoreTestPut = () => {
      IDBObjectStore.prototype.put = original
    }
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'metadata' && args[1] === 'snapshot') {
        this.transaction.abort()
        throw new DOMException('测试本地空间不足', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  await page.getByLabel('编辑节点文字').fill('未保存的编辑内容')
  await expect(page.locator('.save-state')).toHaveText('本地未保存')
  await panes(page)
    .first()
    .getByRole('button', { name: '拖动画布调整位置' })
    .dragTo(panes(page).last())
  await expect(panes(page).first()).toHaveAttribute('data-pane-id', first)
  await expect(panes(page).last()).toHaveAttribute('data-pane-id', second)
  await page.evaluate(() => (window as unknown as { restoreTestPut: () => void }).restoreTestPut())
  await page.getByRole('alert').getByRole('button', { name: '重试保存' }).click()
  await expect(page.locator('.save-state')).toHaveText('本地已保存')
  await page.reload()
  await expect(node(panes(page).first(), '未保存的编辑内容')).toBeVisible()
})

test('全屏工具栏提供子主题、同级、折叠、下钻、布局、撤销重做和常用图标', async ({ page }) => {
  await page.goto('/')
  const pane = panes(page).first(),
    target = node(pane, '想要探索的事')
  await target.click()
  await page.getByRole('button', { name: '旗子 blue', exact: true }).click()
  // 全屏内 Esc 用于退出全屏，先在普通状态取消选择，验证未选中时的整图折叠。
  await page.getByLabel('脑图画布', { exact: true }).press('Escape')
  await expect(page.locator('.mind-node.selected')).toHaveCount(0)
  await pane.getByRole('button', { name: '全屏显示当前画布', exact: true }).click()
  const toolbar = pane.getByRole('toolbar', { name: '全屏画布操作', exact: true })
  await expect(toolbar).toBeVisible()
  const foldAll = toolbar.getByRole('button', { name: '全部折叠 / 展开', exact: true })
  await expect(foldAll).toBeEnabled()
  await expect(toolbar.getByRole('button', { name: '自动布局', exact: true })).toBeEnabled()
  await expect(toolbar.getByRole('button', { name: '＋ 子主题', exact: true })).toBeDisabled()
  await expect(toolbar.getByRole('button', { name: '＋ 同级主题', exact: true })).toBeDisabled()
  await expect(toolbar.getByRole('button', { name: '折叠 / 展开', exact: true })).toBeDisabled()
  await expect(toolbar.getByRole('button', { name: '下钻', exact: true })).toBeDisabled()
  await expect(toolbar.getByRole('button', { name: '撤销', exact: true })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: '重做', exact: true })).toBeVisible()
  const favorite = toolbar.getByRole('button', {
    name: '常用图标：旗子 blue',
    exact: true,
  })
  await expect(favorite).toBeVisible()

  await foldAll.click()
  await expect(node(pane, '想要探索的事')).toHaveCount(0)
  await expect(node(pane, '值得记住的事')).toHaveCount(0)
  await foldAll.click()
  await expect(node(pane, '想要探索的事')).toBeVisible()
  await expect(node(pane, '值得记住的事')).toBeVisible()

  await node(pane, '想要探索的事').click()
  for (const name of ['＋ 子主题', '＋ 同级主题', '折叠 / 展开', '下钻'])
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeEnabled()
  await toolbar.getByRole('button', { name: '＋ 子主题', exact: true }).click()
  const added = node(pane, '新主题')
  await expect(added).toBeVisible()
  await expect(added).toHaveClass(/selected/)
  await toolbar.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(added).toHaveCount(0)
  await toolbar.getByRole('button', { name: '重做', exact: true }).click()
  await expect(added).toBeVisible()

  await node(pane, '想要探索的事').click()
  await foldAll.click()
  await expect(added).toHaveCount(0)
  await expect(node(pane, '值得记住的事')).toBeVisible()
  await foldAll.click()
  await expect(added).toBeVisible()

  await added.click()
  await favorite.click()
  await expect(added.locator('svg')).toHaveCount(1)

  await node(pane, '想要探索的事').click()
  await toolbar.getByRole('button', { name: '折叠 / 展开', exact: true }).click()
  await expect(pane.getByRole('button', { name: '展开 想要探索的事', exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '折叠 / 展开', exact: true }).click()
  await expect(pane.getByRole('button', { name: '折叠 想要探索的事', exact: true })).toBeVisible()

  await toolbar.getByRole('button', { name: '下钻', exact: true }).click()
  await expect(
    pane.getByRole('button', { name: '返回到我的第一个脑图', exact: true }),
  ).toBeVisible()

  await toolbar.getByRole('button', { name: '自动布局', exact: true }).click()
  await expect(pane.locator('.workspace-fullscreen-toast')).toContainText('已均衡布局')
})
