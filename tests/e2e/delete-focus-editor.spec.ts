import { expect, test, type Page } from '@playwright/test'

const node = (page: Page, text: string) =>
  page.getByRole('button', { name: `节点 ${text}`, exact: true })
const selectedInput = (page: Page) => page.getByLabel('输入所选节点文字', { exact: true })

test('键盘删除后选中后一个同级，并可直接继续输入', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await page.keyboard.press('Delete')
  await expect(node(page, '想要探索的事')).toHaveCount(0)
  await expect(node(page, '下一步行动')).toHaveClass(/selected/)
  await expect(selectedInput(page)).toBeFocused()
  await page.keyboard.type('继续输入')
  const editor = page.getByLabel('编辑节点文字', { exact: true })
  await expect(editor).toHaveValue('继续输入')
  await editor.press('Enter')
  await expect(node(page, '继续输入')).toHaveClass(/selected/)
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.reload()
  await expect(node(page, '继续输入')).toHaveClass(/selected/)
})

test('删除末尾节点选择前一个同级，撤销与重做仍正常', async ({ page }) => {
  await page.goto('/')
  await node(page, '值得记住的事').click()
  await page.keyboard.press('Backspace')
  await expect(node(page, '值得记住的事')).toHaveCount(0)
  await expect(node(page, '灵感与收集')).toHaveClass(/selected/)
  await expect(selectedInput(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(node(page, '值得记住的事')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(node(page, '值得记住的事')).toHaveCount(0)
  await expect(node(page, '灵感与收集')).toHaveClass(/selected/)
})

test('删除唯一子节点时选择父节点，中心主题仍受保护', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await page.keyboard.press('Tab')
  await expect(node(page, '新主题')).toHaveClass(/selected/)
  await page.keyboard.press('Delete')
  await expect(node(page, '新主题')).toHaveCount(0)
  await expect(node(page, '想要探索的事')).toHaveClass(/selected/)
  await expect(selectedInput(page)).toBeFocused()
  await node(page, '我的第一个脑图').click()
  await page.keyboard.press('Delete')
  await expect(node(page, '我的第一个脑图')).toBeVisible()
  await expect(page.getByText('中心主题不能直接删除，请将脑图移至回收站')).toBeVisible()
})

test('批量删除跳过被删除的同级，选择下一个保留的节点', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await node(page, '下一步行动').click({ modifiers: ['Shift'] })
  await expect(page.locator('.mind-node.selected')).toHaveCount(2)
  await page.keyboard.press('Delete')
  await expect(node(page, '想要探索的事')).toHaveCount(0)
  await expect(node(page, '下一步行动')).toHaveCount(0)
  await expect(node(page, '灵感与收集')).toHaveClass(/selected/)
  await expect(page.locator('.mind-node.selected')).toHaveCount(1)
  await expect(selectedInput(page)).toBeFocused()
})

test('节点面板删除后焦点回到新的选中节点', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await page.getByRole('button', { name: '删除分支', exact: true }).click()
  await expect(node(page, '想要探索的事')).toHaveCount(0)
  await expect(node(page, '下一步行动')).toHaveClass(/selected/)
  await expect(selectedInput(page)).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByLabel('编辑节点文字', { exact: true })).toHaveValue('下一步行动')
})

test('下钻视图删除当前子树后选择相邻同级', async ({ page }) => {
  await page.goto('/')
  await node(page, '想要探索的事').click()
  await page.getByRole('button', { name: '下钻', exact: true }).click()
  await expect(page.getByLabel('下钻路径')).toBeVisible()
  await node(page, '想要探索的事').click()
  await page.keyboard.press('Delete')
  await expect(node(page, '想要探索的事')).toHaveCount(0)
  await expect(node(page, '下一步行动')).toHaveClass(/selected/)
})

test('拆分画布删除节点只改变操作画布的选中焦点', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '左右拆分画布', exact: true }).click()
  const panes = page.getByTestId('workspace-layout').locator('.workspace-pane'),
    left = panes.nth(0),
    right = panes.nth(1)
  await expect(panes).toHaveCount(2)
  await right.getByRole('button', { name: '节点 值得记住的事', exact: true }).click()
  await left.getByRole('button', { name: '节点 想要探索的事', exact: true }).click()
  await page.keyboard.press('Delete')
  await expect(left.getByRole('button', { name: '节点 下一步行动', exact: true })).toHaveClass(
    /selected/,
  )
  await expect(right.getByRole('button', { name: '节点 值得记住的事', exact: true })).toHaveClass(
    /selected/,
  )
  await expect(left.getByLabel('输入所选节点文字')).toBeFocused()
})
