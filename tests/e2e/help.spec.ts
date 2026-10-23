import { expect, test } from '@playwright/test'

const categories = [
  '快速开始',
  '节点编辑与整理',
  '快捷键',
  '画布与分区',
  '多脑图管理',
  '导入与备份',
  '保存、离线与同步',
  '登录与账号恢复',
  '常见问题与限制',
]

test('使用指南九个栏目、正文搜索、安全提示、相关主题和空结果', async ({ page }) => {
  await page.goto('/')
  const open = page.getByRole('button', { name: '使用指南', exact: true })
  await open.focus()
  await open.press('Enter')
  const dialog = page.getByRole('dialog')
  const nav = dialog.getByRole('navigation', { name: '帮助栏目' })
  const search = dialog.getByRole('searchbox', { name: '搜索帮助文章' })
  await expect(search).toBeFocused()
  await expect(nav.getByRole('button')).toHaveCount(9)
  for (const title of categories) {
    const link = nav.getByRole('button', { name: new RegExp(`^${title}`) })
    await link.click()
    await expect(link).toHaveAttribute('aria-current', 'page')
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  await search.fill('损坏文件整批取消')
  await expect(nav.getByRole('button')).toHaveCount(1)
  await expect(dialog.getByRole('heading', { name: '导入与备份', exact: true })).toBeVisible()
  await expect(dialog.getByRole('complementary', { name: 'JSON 不是完整备份' })).toContainText(
    '不能替代服务端完整备份',
  )
  await dialog
    .getByRole('navigation', { name: '相关主题' })
    .getByRole('button', { name: /保存、离线与同步/ })
    .click()
  await expect(search).toHaveValue('')
  await expect(nav.getByRole('button')).toHaveCount(9)
  await expect(dialog.getByRole('heading', { name: '保存、离线与同步', exact: true })).toBeVisible()
  await expect(
    dialog.getByRole('complementary', { name: '不要清除站点数据来排查同步' }),
  ).toContainText('待同步队列')
  await search.fill('不存在的帮助词条')
  await expect(dialog.getByRole('heading', { name: '没有找到相关内容' })).toBeVisible()
  await dialog.getByRole('button', { name: '浏览全部栏目' }).click()
  await expect(nav.getByRole('button')).toHaveCount(9)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(open).toBeFocused()
})

test('三组配图加载完整且有图注/替代文本，同步状态图准确区分本机与云端', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '使用指南', exact: true }).click()
  const help = page.getByRole('dialog')
  const nav = help.getByRole('navigation', { name: '帮助栏目' })

  await nav.getByRole('button', { name: /^快速开始/ }).click()
  const overview = help.getByRole('img', { name: /界面示意/ })
  await overview.scrollIntoViewIfNeeded()
  await expect(overview).toHaveJSProperty('naturalWidth', 1440)
  await expect(help.getByText('脑图列表，以及导入、备份和帮助入口。')).toBeVisible()
  await expect(help.getByRole('link', { name: '查看原图' })).toHaveAttribute('target', '_blank')

  await nav.getByRole('button', { name: /^画布与分区/ }).click()
  const canvasImages = help.getByRole('article').locator('.help-illustration img')
  await expect(canvasImages).toHaveCount(3)
  for (const image of await canvasImages.all()) {
    await image.scrollIntoViewIfNeeded()
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
      )
      .toBe(true)
  }
  await expect(help.getByText('步骤 1：用分区右上角的拆分按钮复制当前视图。')).toBeVisible()
  await expect(help.getByText('步骤 2：打开分区标题，选择脑图和要查看的节点范围。')).toBeVisible()
  await expect(help.getByText('步骤 3：使用标题路径中的上层项目返回。')).toBeVisible()

  await nav.getByRole('button', { name: /^保存、离线与同步/ }).click()
  const flow = help.getByRole('group', { name: '本机保存与云端同步状态图' })
  await expect(flow.getByRole('region', { name: '本机保存状态' })).toBeVisible()
  await expect(flow.getByRole('region', { name: '云端同步状态' })).toBeVisible()
  await expect(flow.getByText('本地已保存', { exact: true })).toBeVisible()
  await expect(flow.getByText('待同步', { exact: true })).toBeVisible()
  await expect(flow.getByText('已同步', { exact: true })).toBeVisible()
  await expect(flow.getByText('离线或同步失败')).toBeVisible()
})

test('完整快捷键分组检索、切换系统，保留原快速面板', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '快捷键', exact: true }).click()
  const quick = page.getByRole('dialog')
  await expect(quick.getByText('新增子主题')).toBeVisible()
  await quick.getByRole('button', { name: /在使用指南中搜索快捷键/ }).click()
  const help = page.getByRole('dialog')
  await expect(help.getByRole('heading', { name: '快捷键', exact: true })).toBeVisible()
  await expect(help.getByRole('table')).toHaveCount(5)
  const platform = help.getByRole('group', { name: '快捷键系统' })
  await platform.getByRole('button', { name: 'Windows / Linux' }).click()
  const filter = help.getByRole('searchbox', { name: '筛选快捷键' })
  await filter.fill('Ctrl Enter')
  await expect(help.getByRole('table')).toHaveCount(1)
  await expect(help.getByText('Ctrl Enter', { exact: true })).toBeVisible()
  await filter.fill('顺时针')
  await expect(help.getByText('逆时针 / 顺时针调整同级顺序')).toBeVisible()
  await expect(help.getByText('Alt ↑ / Alt ↓', { exact: true })).toBeVisible()
  await platform.getByRole('button', { name: 'macOS' }).click()
  await expect(help.getByText('⌥ ↑ / ⌥ ↓', { exact: true })).toBeVisible()
  await filter.fill('不存在的快捷键')
  await expect(help.getByText(/没有匹配的快捷键/)).toBeVisible()
  await help.getByRole('searchbox', { name: '搜索帮助文章' }).fill('Tab')
  await expect(help.getByRole('heading', { name: '快捷键', exact: true })).toBeVisible()
})

test('窄屏帮助独立滚动，弹窗操作保留画布的内容、选择和视角', async ({ page }, testInfo) => {
  await page.goto('/')
  const node = page.getByRole('button', { name: '节点 想要探索的事', exact: true })
  await node.click()
  const count = await page.locator('.mind-node').count()
  const selected = await page.locator('.mind-node.selected').getAttribute('data-node-id')
  const transform = await page.locator('.graph > g').first().getAttribute('transform')
  await page.getByRole('button', { name: '使用指南', exact: true }).click()
  const help = page.getByRole('dialog')
  await page.keyboard.press('Control+]')
  await expect(page.getByLabel('节点属性', { exact: true })).toBeVisible()
  await help.getByRole('searchbox', { name: '搜索帮助文章' }).fill('不能替代服务端完整备份')
  await expect(page.locator('.mind-node')).toHaveCount(count)
  await help.getByRole('button', { name: '关闭对话框' }).click()
  await expect(page.locator('.mind-node.selected')).toHaveAttribute('data-node-id', selected!)
  await expect(page.locator('.graph > g').first()).toHaveAttribute('transform', transform!)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '使用指南', exact: true }).click()
  const nav = help.getByRole('navigation', { name: '帮助栏目' })
  await nav.getByRole('button', { name: /^保存、离线与同步/ }).click()
  const article = help.getByRole('article')
  await expect(
    article.getByRole('heading', { name: '保存、离线与同步', exact: true }),
  ).toBeVisible()
  const layout = await help.evaluate((dialog) => {
    const body = dialog.querySelector('.help-article')!
    const r = dialog.getBoundingClientRect()
    return {
      overflows: dialog.scrollWidth > dialog.clientWidth,
      articleScrolls: body.scrollHeight > body.clientHeight,
      bottom: r.bottom,
      height: innerHeight,
    }
  })
  expect(layout.overflows).toBe(false)
  expect(layout.articleScrolls).toBe(true)
  expect(layout.bottom).toBeLessThanOrEqual(layout.height)
  await article
    .getByRole('complementary', { name: '不要清除站点数据来排查同步' })
    .scrollIntoViewIfNeeded()
  await expect(
    article.getByRole('complementary', { name: '不要清除站点数据来排查同步' }),
  ).toBeInViewport()
  await nav.getByRole('button', { name: /^画布与分区/ }).click()
  const images = article.locator('.help-illustration img')
  await expect(images).toHaveCount(3)
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded()
    const dimensions = await image.evaluate((element) => {
      const image = element.getBoundingClientRect()
      const article = element.closest('.help-article')!.getBoundingClientRect()
      return { imageWidth: image.width, articleWidth: article.width }
    })
    expect(dimensions.imageWidth).toBeLessThanOrEqual(dimensions.articleWidth)
  }
  await page.screenshot({ path: testInfo.outputPath('使用指南-窄屏.png') })
})
