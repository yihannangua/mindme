import { expect, test } from '@playwright/test'

const root = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '节点 我的第一个脑图', exact: true })
const firstChild = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '节点 想要探索的事', exact: true })
const secondChild = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: '节点 下一步行动', exact: true })

test('从节点创建曲线连线，并在连线标签上修改文字和刷新恢复', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  const target = firstChild(page)
  await root(page).click()
  await page.locator('.toolbar').getByRole('button', { name: '连线', exact: true }).click()
  await expect(page.getByText(/连线中：点击目标节点/)).toBeVisible()
  await target.click()

  const label = page.getByRole('button', { name: '编辑连线：关系', exact: true })
  await expect(label).toBeVisible()
  await expect(page.locator('.node-link')).toHaveCount(1)
  await expect(page.locator('.node-link')).toHaveAttribute('data-from-side', '1')
  await expect(page.locator('.node-link')).toHaveAttribute('data-to-side', '1')
  await label.click()
  const input = page.getByLabel('编辑连线文字', { exact: true })
  await expect(input).toBeFocused()
  await input.fill('依赖')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '编辑连线：依赖', exact: true })).toBeVisible()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: '编辑连线：依赖', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('概括节点像普通节点一样编辑文字并继续创建子节点', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await root(page).click()
  await page.locator('.toolbar').getByRole('button', { name: '概括', exact: true }).click()

  const summary = page.getByRole('button', { name: '节点 概要', exact: true })
  await expect(summary).toBeVisible()
  await expect(summary).toHaveAttribute('data-anchor-count', '4')
  await expect(page.locator('.summary-bracket')).toHaveCount(1)
  const summaryId = await summary.getAttribute('data-node-id')

  await summary.dblclick()
  const input = page.getByLabel('编辑节点文字', { exact: true })
  await expect(input).toBeFocused()
  await input.fill('运维概要')
  await input.press('Enter')
  const edited = page.getByRole('button', { name: '节点 运维概要', exact: true })
  await expect(edited).toBeVisible()

  await edited.click()
  await page.keyboard.press('Tab')
  const child = page.getByRole('button', { name: '节点 新主题', exact: true })
  await expect(child).toHaveCount(1)
  await expect(child).toHaveAttribute('data-parent-id', summaryId!)
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  await expect(child).toBeVisible()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()

  await page.reload()
  await expect(edited).toBeVisible()
  await expect(child).toHaveCount(1)
  await expect(page.locator('.summary-bracket')).toHaveCount(1)
})

test('多选连续同级节点后一次生成概括节点', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await firstChild(page).click()
  await secondChild(page).click({ modifiers: ['Shift'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await page.locator('.toolbar').getByRole('button', { name: '概括', exact: true }).click()

  const summary = page.getByRole('button', { name: '节点 概要', exact: true })
  await expect(summary).toBeVisible()
  await expect(summary).toHaveAttribute('data-anchor-count', '2')
  await expect(page.locator('.summary-bracket')).toHaveCount(1)
})

test('左侧连续节点的概括出现在左侧，括号上下留出间隙', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  const leftA = page.getByRole('button', { name: '节点 灵感与收集', exact: true }),
    leftB = page.getByRole('button', { name: '节点 值得记住的事', exact: true })
  await leftA.click()
  await leftB.click({ modifiers: ['Shift'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await page.locator('.toolbar').getByRole('button', { name: '概括', exact: true }).click()

  const summary = page.getByRole('button', { name: '节点 概要', exact: true })
  await expect(summary).toHaveAttribute('data-summary-side', '-1')
  const summaryBox = await summary.boundingBox(),
    boxA = await leftA.boundingBox(),
    boxB = await leftB.boundingBox(),
    bracketBox = await page.locator('.summary-bracket').boundingBox()
  expect(summaryBox).not.toBeNull()
  expect(boxA).not.toBeNull()
  expect(boxB).not.toBeNull()
  expect(bracketBox).not.toBeNull()
  expect(summaryBox!.x + summaryBox!.width).toBeLessThan(Math.min(boxA!.x, boxB!.x))
  const top = Math.min(boxA!.y, boxB!.y),
    bottom = Math.max(boxA!.y + boxA!.height, boxB!.y + boxB!.height)
  expect(bracketBox!.y).toBeLessThan(top)
  expect(bracketBox!.y + bracketBox!.height).toBeGreaterThan(bottom)
})

test('紧凑画布下概括使用紧凑括号样式', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await root(page).click()
  await page.locator('.toolbar').getByRole('button', { name: '概括', exact: true }).click()
  const summary = page.getByRole('button', { name: '节点 概要', exact: true })
  await expect(summary).toBeVisible()
  await expect(summary).not.toHaveClass(/root-node/)

  await page.getByRole('button', { name: '当前画布风格：经典', exact: true }).click()
  await page.getByRole('option', { name: '紧凑', exact: true }).click()
  await expect(page.getByRole('button', { name: '当前画布风格：紧凑', exact: true })).toBeVisible()
  const path = page.locator('.summary-bracket')
  const geometry = await path.getAttribute('d')
  expect(geometry).toContain('H')
  expect(geometry).not.toContain('C')
  await expect(summary).toBeVisible()
})
