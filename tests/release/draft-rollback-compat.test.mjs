import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const BASELINE = '19cb73f3b908dd8198b7dc2c738b0384202adee4'

test('真实 v0.1.7 回滚恢复新版草稿，旧版继续编辑后新版重启保留队列', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindme-draft-compat-'))
  try {
    const oldSource = join(directory, 'old-source')
    await mkdir(oldSource)
    const archive = execFileSync('git', ['archive', BASELINE], { maxBuffer: 100 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', oldSource], { input: archive })
    async function bundle(source, name) {
      const outfile = join(directory, `${name}.mjs`)
      await build({
        entryPoints: [join(source, 'src/app/store.ts')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
      })
      return (await import(pathToFileURL(outfile).href)).AppStore
    }
    const OldStore = await bundle(oldSource, 'old')
    const NewStore = await bundle(resolve('.'), 'new')
    const newest = new NewStore()
    await newest.init()
    const initial = newest.getSnapshot().snapshot
    assert(initial)
    const map = Object.values(initial.space.maps)[0]
    await newest.editorDraft({
      mapId: map.id,
      nodeId: map.rootId,
      text: '新版未提交草稿',
      original: map.title,
      at: Date.now(),
    })
    const old = new OldStore()
    await old.init()
    const recovered = old.getSnapshot().snapshot
    assert(recovered)
    assert.equal(recovered.space.maps[map.id].title, '新版未提交草稿')
    assert(
      recovered.outbox.some((op) => op.changes.some((change) => change.after === '新版未提交草稿')),
    )
    await assert.rejects(
      newest.editorDraft({
        mapId: map.id,
        nodeId: map.rootId,
        text: '过期页面',
        original: map.title,
        at: Date.now(),
      }),
      /其他页面/,
    )
    await old.command(map.id, { type: 'text', nodeId: map.rootId, text: '旧版继续编辑' })
    const pending = old.getSnapshot().snapshot.outbox.map((op) => op.opId)
    const restored = new NewStore()
    await restored.init()
    const result = restored.getSnapshot().snapshot
    assert(result)
    assert.equal(result.space.maps[map.id].title, '旧版继续编辑')
    assert(pending.every((id) => result.outbox.some((op) => op.opId === id)))
    assert.equal(result.editorDraft, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
