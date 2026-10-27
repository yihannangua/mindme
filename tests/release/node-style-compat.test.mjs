import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const BASELINE = '8e65bedae69d35322223ea4888ee104dc1487cad'

test('真实 v0.1.6 代码与节点样式混版、回滚和旧设备离线写入兼容', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mindme-node-style-compat-'))
  let db
  try {
    const oldSource = join(directory, 'old-source')
    await mkdir(oldSource)
    const archive = execFileSync('git', ['archive', BASELINE], { maxBuffer: 100 * 1024 * 1024 })
    execFileSync('tar', ['-x', '-C', oldSource], { input: archive })
    async function bundle(source, name, entries) {
      const outdir = join(directory, name)
      await build({
        entryPoints: entries.map((entry) => join(source, entry)),
        outbase: source,
        outdir,
        outExtension: { '.js': '.mjs' },
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
      })
      return outdir
    }
    const old = await bundle(oldSource, 'old', [
      'server/space.ts',
      'server/database.ts',
      'src/domain/operations.ts',
    ])
    const current = await bundle(resolve('.'), 'current', [
      'server/space.ts',
      'server/database.ts',
      'src/domain/operations.ts',
      'src/domain/model.ts',
      'src/domain/commands.ts',
    ])
    const load = (root, path) => import(pathToFileURL(join(root, path)).href)
    const { ServerDatabase: NewDatabase } = await load(current, 'server/database.mjs')
    const { PersonalSpace: NewSpace } = await load(current, 'server/space.mjs')
    const { ServerDatabase: OldDatabase } = await load(old, 'server/database.mjs')
    const { PersonalSpace: OldSpace } = await load(old, 'server/space.mjs')
    const { applyChanges: oldApply, diffSpace: oldDiff } = await load(
      old,
      'src/domain/operations.mjs',
    )
    const { diffSpace } = await load(current, 'src/domain/operations.mjs')
    const { createMap, makeNode } = await load(current, 'src/domain/model.mjs')
    const { execute } = await load(current, 'src/domain/commands.mjs')

    const empty = { schemaVersion: 1, maps: {}, tabs: {} }
    let sequence = 0
    const ctx = (now = 1000) => ({ now, id: () => `id-${++sequence}` })
    const original = createMap(empty, '隔离演练', ctx())
    const map = Object.values(original.maps)[0]
    map.nodes.child = makeNode('child', map.rootId, '初始内容')
    const op = (id, changes, baseRevision, at) => ({
      schemaVersion: 1,
      opId: id,
      stamp: { deviceId: `device-${id}`, deviceSeq: 1, at, uncertainty: 0 },
      baseRevision,
      changes,
      state: 'pending',
      attempts: 0,
    })

    const file = join(directory, 'isolation.sqlite')
    db = new NewDatabase(file)
    db.writeMeta('subject', 'fixture')
    let space = new NewSpace(db)
    const initial = space.sync(0, [op('bootstrap', diffSpace(empty, original), 0, 1000)], 1000)
    assert.equal(initial.results[0].status, 'accepted')
    const oldOffline = structuredClone(original)
    oldOffline.maps[map.id].nodes.child.text = '旧设备离线修改'
    const oldOfflineOp = op('old-offline', oldDiff(original, oldOffline), initial.seq, 1100)
    const styled = execute(
      original,
      map.id,
      {
        type: 'style-many',
        nodeIds: ['child'],
        style: { fontSize: 28, backgroundColor: '#123456', fontFamily: 'serif' },
      },
      ctx(1200),
    ).space
    const styleResult = space.sync(
      initial.seq,
      [op('style-initial', diffSpace(original, styled), initial.seq, 1200)],
      1200,
    )
    assert.equal(styleResult.results[0].status, 'accepted')
    assert(styleResult.changes.some((change) => change.field === '$node'))
    assert(
      !styleResult.changes.some((change) =>
        ['fontSize', 'fontFamily', 'backgroundColor'].includes(change.field),
      ),
    )
    assert.equal(
      oldApply(original, styleResult.changes, 1200).maps[map.id].nodes.child.fontSize,
      28,
    )
    const offlineResult = space.sync(styleResult.seq, [oldOfflineOp], 1300)
    assert.equal(offlineResult.results[0].status, 'accepted')
    const latest = db.export().state.space
    assert.equal(latest.maps[map.id].nodes.child.text, '旧设备离线修改')
    assert.equal(latest.maps[map.id].nodes.child.backgroundColor, '#123456')
    db.close()

    db = new OldDatabase(file)
    space = new OldSpace(db)
    const oldResponse = space.sync(initial.seq, [], 1400)
    const oldReplayed = oldApply(original, oldResponse.changes, 1400)
    assert.equal(oldReplayed.maps[map.id].nodes.child.fontSize, 28)
    assert.equal(oldReplayed.maps[map.id].nodes.child.text, '旧设备离线修改')
    const next = execute(
      latest,
      map.id,
      {
        type: 'style-many',
        nodeIds: ['child'],
        style: { fontSize: 36 },
      },
      ctx(1500),
    ).space
    const rejected = op('during-rollback', diffSpace(latest, next), oldResponse.seq, 1500)
    const rejectedResponse = space.sync(oldResponse.seq, [rejected], 1500)
    assert.equal(rejectedResponse.results[0].status, 'rejected')
    const afterRollback = structuredClone(latest)
    afterRollback.maps[map.id].nodes.child.text = '回滚期间的新文字'
    const legacyResult = space.sync(
      rejectedResponse.seq,
      [op('during-rollback-text', oldDiff(latest, afterRollback), rejectedResponse.seq, 1600)],
      1600,
    )
    assert.equal(legacyResult.results[0].status, 'accepted')
    assert.equal(db.export().state.space.maps[map.id].nodes.child.fontSize, 28)
    db.close()

    db = new NewDatabase(file)
    space = new NewSpace(db)
    const replay = space.sync(legacyResult.seq, [{ ...rejected, opId: 'rekeyed-style' }], 1700)
    assert.equal(replay.results[0].status, 'accepted')
    const final = db.export().state.space.maps[map.id].nodes.child
    assert.equal(final.fontSize, 36)
    assert.equal(final.backgroundColor, '#123456')
    assert.equal(final.text, '回滚期间的新文字')
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
