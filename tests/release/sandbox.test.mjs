import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cleanupSandbox } from '../../scripts/release/sandbox.mjs'

test('清理隔离沙箱包含的嵌套文件，不删除其他目录', async () => {
  const path = await mkdtemp(join(tmpdir(), 'mindme-release-rehearsal-'))
  await mkdir(join(path, 'releases'))
  await writeFile(join(path, 'releases', 'record.json'), '{}', { mode: 0o600 })
  await cleanupSandbox(path)
  await assert.rejects(access(path), { code: 'ENOENT' })
})

test('清理器拒绝其他临时目录及伪装为沙箱的符号链接', async () => {
  const other = await mkdtemp(join(tmpdir(), 'mindme-cleanup-fixture-'))
  const link = `${other.replace('mindme-cleanup-fixture-', 'mindme-release-rehearsal-')}link`
  try {
    await assert.rejects(cleanupSandbox(other), /名称非法/)
    await symlink(other, link)
    await assert.rejects(cleanupSandbox(link), /符号链接/)
    await access(other)
  } finally {
    await rm(link, { force: true })
    await rm(other, { recursive: true, force: true })
  }
})
