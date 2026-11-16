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

test('概括单个节点的所有子节点，编辑概括文字并刷新恢复', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await root(page).click()
  await page.locator('.toolbar').getByRole('button', { name: '概括', exact: true }).click()

  const summary = page.getByRole('button', { name: '编辑概括：概要', exact: true })
  await expect(summary).toBeVisible()
  await expect(summary).toHaveAttribute('data-anchor-count', '4')
  await expect(page.locator('.summary-bracket')).toHaveCount(1)
  await summary.click()
  const input = page.getByLabel('编辑概括文字', { exact: true })
  await expect(input).toBeFocused()
  await input.fill('运维概要')
  await input.press('Enter')
  await expect(page.getByRole('button', { name: '编辑概括：运维概要', exact: true })).toBeVisible()
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: '编辑概括：运维概要', exact: true })).toBeVisible()
  await expect(page.locator('.summary-bracket')).toHaveCount(1)
})

test('多选连续同级节点后一次生成概括', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await firstChild(page).click()
  await secondChild(page).click({ modifiers: ['Shift'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await page.locator('.toolbar').getByRole('button', { name: '概括', exact: true }).click()

  const summary = page.getByRole('button', { name: '编辑概括：概要', exact: true })
  await expect(summary).toBeVisible()
  await expect(summary).toHaveAttribute('data-anchor-count', '2')
  await expect(page.locator('.summary-bracket')).toHaveCount(1)
})
