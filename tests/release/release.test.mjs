import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { pack, safePath, unpack, verifyPackage } from '../../scripts/release/archive.mjs'
import { validateCi } from '../../scripts/release/provenance.mjs'

const sha = 'c'.repeat(40)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const jobNames = ['类型、格式、测试与构建', '浏览器与 Node 后端回归', '容器构建与备份恢复']
const successfulCi = () => ({
  id: 39257934575,
  repository: { full_name: 'yihannangua/mindme' },
  head_repository: { full_name: 'yihannangua/mindme' },
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 2,
  html_url: 'https://github.com/yihannangua/mindme/actions/runs/39257934575',
})
const successfulJobs = () =>
  Object.fromEntries(
    jobNames.map((name, id) => [id, { name, status: 'completed', conclusion: 'success' }]),
  )

test('CI 证明绑定公开 main 的完整 SHA、run ID、当前 attempt 与全部必需 job', () => {
  const ci = successfulCi()
  assert.equal(validateCi(ci, successfulJobs(), sha, ci.id).attempt, 2)
  assert.throws(() => validateCi(ci, successfulJobs(), sha, ci.id + 1), /run ID 不符/)
  assert.throws(() => validateCi(ci, successfulJobs(), 'c'.repeat(39), ci.id), /完整的 40 位/)
  assert.throws(() => validateCi(ci, {}, sha, ci.id), /缺少必要 CI 作业/)
  assert.throws(
    () => validateCi({ ...ci, conclusion: 'failure' }, successfulJobs(), sha, ci.id),
    /CI 未成功/,
  )
})

test('归档路径拒绝私有配置、用户数据和路径穿越', () => {
  for (const path of [
    '../secret',
    '/etc/passwd',
    'deploy/server.env',
    'deploy/.env',
    'data/mindme.sqlite',
    'backup.sqlite-wal',
    '.obsidian-vault/00-入口.md',
  ])
    assert.equal(safePath(path), false, path)
  assert.equal(safePath('deploy/compose.yaml'), true)
})

test('归档校验绑定 SHA、成功 CI、逐文件摘要及精确白名单', () => {
  const payload = {
    'dist/index.html': Buffer.from('<main>mindme</main>'),
    'dist-server/index.js': Buffer.from('process.exitCode = 0'),
    'dist-server/cli.js': Buffer.from('process.exitCode = 0'),
    'package.json': Buffer.from('{"version":"0.1.2"}'),
    'package-lock.json': Buffer.from('{"version":"0.1.2","packages":{"":{"version":"0.1.2"}}}'),
    'deploy/compose.yaml': Buffer.from('services: {}\n'),
    'deploy/release.Dockerfile': Buffer.from('FROM node:24-bookworm-slim\n'),
    LICENSE: Buffer.from('MIT\n'),
    'THIRD_PARTY_NOTICES.txt': Buffer.from('MIT notices\n'),
  }
  const ci = {
    repository: 'yihannangua/mindme',
    runId: 39257934575,
    attempt: 2,
    headSha: sha,
    headBranch: 'main',
    event: 'push',
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
    jobs: jobNames.map((name) => ({ name, conclusion: 'success' })),
  }
  const manifest = {
    releaseProtocol: 1,
    repository: 'yihannangua/mindme',
    sha,
    version: '0.1.2',
    ci,
    lockSha256: hash(payload['package-lock.json']),
    files: Object.fromEntries(
      Object.entries(payload).map(([name, data]) => [
        name,
        { bytes: data.length, sha256: hash(data) },
      ]),
    ),
  }
  const files = { ...payload, 'release-source.json': Buffer.from(JSON.stringify(manifest)) }
  const archive = pack(files)
  const digest = hash(archive)
  assert.equal(verifyPackage(archive, { sha, ci: ci.runId, sha256: digest }).manifest.sha, sha)
  assert.throws(
    () => verifyPackage(archive, { sha, ci: ci.runId, sha256: '0'.repeat(64) }),
    /摘要不一致/,
  )
  assert.throws(
    () => verifyPackage(archive, { sha: 'd'.repeat(40), ci: ci.runId, sha256: digest }),
    /源码 SHA 不符/,
  )

  assert.throws(
    () => pack({ ...files, 'deploy/server.env': Buffer.from('SESSION_SECRET=fixture') }),
    /归档路径不安全/,
  )
})

test('归档解包拒绝重复成员与符号链接', () => {
  const makeHeader = (name, body, type = '0') => {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100)
    for (const [offset, size, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, body.length],
      [136, 12, 0],
    ])
      header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size)
    header.fill(32, 148, 156)
    header.write(type, 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(
      [...header]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      8,
    )
    return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
  }
  const duplicate = gzipSync(
    Buffer.concat([
      makeHeader('dist/index.html', Buffer.from('first')),
      makeHeader('dist/index.html', Buffer.from('second')),
      Buffer.alloc(1024),
    ]),
  )
  assert.throws(() => unpack(duplicate), /重复路径/)

  const link = gzipSync(
    Buffer.concat([makeHeader('dist/link', Buffer.alloc(0), '2'), Buffer.alloc(1024)]),
  )
  assert.throws(() => unpack(link), /只接受普通文件/)
})
