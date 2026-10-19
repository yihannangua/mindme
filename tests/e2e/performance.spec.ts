import { expect, test } from '@playwright/test'
import { makeNode } from '../../src/domain/model'
import type { Backup } from '../../src/importers/backup'
import type { MindNode } from '../../src/domain/types'
import { writeFile } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
const nodes: Record<string, MindNode> = { root: makeNode('root', null, '千节点性能基线') }
for (let i = 0; i < 10; i++) {
  const id = `branch-${i}`
  nodes[id] = { ...makeNode(id, 'root', `分支 ${i}`, i), side: i < 5 ? 1 : -1 }
  for (let j = 0; j < 99; j++) {
    const child = `${id}-${j}`
    nodes[child] = makeNode(
      child,
      id,
      j % 7 === 0 ? '需要完整显示的中文与 English 长文字 👨‍👩‍👧‍👦'.repeat(2) : `主题 ${j}`,
      j,
    )
    if (j % 5 === 0) nodes[child].markers = { priority: '①', flag: 'blue', progress: '4/8' }
  }
}
const backup: Backup = {
  format: 'mindme',
  schemaVersion: 1,
  exportedAt: 1000,
  maps: [{ id: 'benchmark', title: '千节点性能基线', rootId: 'root', nodes, deletedAt: null }],
  tabs: [{ mapId: 'benchmark', open: true, pinned: false, order: 0 }],
}
test('1001 节点导入、编辑、保存和缩放帧间隔实测', async ({ page, browserName, browser }, info) => {
  await page.goto('/')
  await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '导入', exact: true }).click()
  await page.getByRole('button', { name: 'JSON 备份', exact: true }).click()
  const importStart = Date.now()
  await page.getByLabel('选择导入文件').setInputFiles({
    name: 'benchmark.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await expect(page.getByText('已恢复 1 张脑图的新副本。', { exact: false })).toBeVisible()
  const importMs = Date.now() - importStart
  await page.getByLabel('关闭对话框').click()
  await expect(page.getByRole('button', { name: '节点 千节点性能基线', exact: true })).toBeVisible()
  const editMs: number[] = [],
    saveMs: number[] = []
  for (let i = 0; i < 5; i++) {
    await page
      .getByRole('button', {
        name: `节点 ${i ? `基线文字 ${i - 1}` : '千节点性能基线'}`,
        exact: true,
      })
      .dblclick()
    await page.getByLabel('编辑节点文字').fill(`基线文字 ${i}`)
    await expect(page.getByText('本地已保存', { exact: true })).toBeVisible()
    const timings = await page.getByLabel('编辑节点文字').evaluate(async (input, text) => {
      const start = performance.now()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      let paint: number | undefined, save: number | undefined
      while (performance.now() - start < 5000) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        if (
          paint === undefined &&
          document.querySelector('.node-label')?.closest('.root-node')?.textContent?.includes(text)
        )
          paint = performance.now() - start
        if (
          document.querySelector('.save-state')?.textContent === '本地已保存' &&
          !document.querySelector('.inline-editor')
        ) {
          save = performance.now() - start
          break
        }
      }
      return { paint, save }
    }, `基线文字 ${i}`)
    expect(timings.paint).toBeDefined()
    editMs.push(timings.paint!)
    saveMs.push(timings.save!)
  }
  const frameTimes = await page
    .getByLabel('脑图画布', { exact: true })
    .evaluate(async (element) => {
      const intervals: number[] = []
      let previous = performance.now()
      for (let i = 0; i < 60; i++) {
        element.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: i < 30 ? -5 : 5,
            metaKey: true,
            clientX: 650,
            clientY: 400,
            bubbles: true,
            cancelable: true,
          }),
        )
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const now = performance.now()
        intervals.push(now - previous)
        previous = now
      }
      return intervals
    })
  const sorted = [...frameTimes].sort((a, b) => a - b)
  const result = {
    date: new Date().toISOString().slice(0, 10),
    browserName,
    version: browser.version(),
    machine: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0].model,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
    },
    dataset: { nodes: 1001, longText: true, markers: true },
    viewport: { width: 1440, height: 1000 },
    importMs,
    editPaintMs: editMs,
    localSaveMs: saveMs,
    zoomFrameIntervalMs: {
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      maximum: sorted.at(-1),
    },
    editTargetPassed: editMs.every((ms) => ms <= 100),
    limitations:
      'Playwright 自动化引擎、开发服务器与合成事件；不能等同原生 Chrome/Safari、物理屏幕帧率或真实输入法验收。',
  }
  await writeFile(info.outputPath('performance.json'), JSON.stringify(result, null, 2))
  await info.attach('性能实测', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  })
  console.log(JSON.stringify(result))
  expect(editMs.every((ms) => ms <= 100)).toBe(true)
  expect(frameTimes).toHaveLength(60)
})
