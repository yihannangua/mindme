import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const script = new URL('../../scripts/release/database-summary.cjs', import.meta.url)

function createDatabase(path, rows) {
  const database = new DatabaseSync(path)
  database.exec('CREATE TABLE mixed (id INTEGER PRIMARY KEY, value, payload BLOB)')
  const insert = database.prepare('INSERT INTO mixed VALUES (?, ?, ?)')
  for (const row of rows) insert.run(...row)
  database.close()
}

function summarize(path) {
  return JSON.parse(execFileSync(process.execPath, [script.pathname, path], { encoding: 'utf8' }))
}

test('数据库摘要不依赖插入顺序，且能发现任意行内容变化', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindme-db-summary-'))
  try {
    const first = join(directory, 'first.sqlite')
    const reordered = join(directory, 'reordered.sqlite')
    const changed = join(directory, 'changed.sqlite')
    const rows = [
      [1, '文本', Buffer.from([0, 1, 255])],
      [2, 42, Buffer.from([3, 4])],
      [3, null, null],
    ]
    createDatabase(first, rows)
    createDatabase(reordered, [...rows].reverse())
    createDatabase(changed, [...rows.slice(0, 2), [3, '变化', null]])

    const original = summarize(first)
    assert.equal(original.integrity, 'ok')
    assert.deepEqual(summarize(reordered), original)
    assert.notEqual(summarize(changed).content, original.content)
    assert.deepEqual(original.counts, { mixed: 3 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('96 MiB 历史库在 32 MiB Node 堆限制下通过流式核验', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mindme-db-summary-large-'))
  try {
    const path = join(directory, 'history.sqlite')
    const database = new DatabaseSync(path)
    database.exec('CREATE TABLE history (id INTEGER PRIMARY KEY, data TEXT NOT NULL); BEGIN')
    const insert = database.prepare('INSERT INTO history VALUES (?, ?)')
    const payload = 'x'.repeat(512 * 1024)
    for (let index = 0; index < 192; index++) insert.run(index, payload)
    database.exec('COMMIT')
    database.close()
    const output = execFileSync(process.execPath, ['--max-old-space-size=32', '-', path], {
      encoding: 'utf8',
      input: readFileSync(script, 'utf8'),
    })
    const result = JSON.parse(output)
    assert.equal(result.integrity, 'ok')
    assert.deepEqual(result.counts, { history: 192 })
    assert.match(result.content, /^[a-f0-9]{64}$/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
