import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'
import { sha256 } from './provenance.mjs'

export const safePath = (name) =>
  typeof name === 'string' &&
  name.length < 100 &&
  /^[A-Za-z0-9_./-]+$/.test(name) &&
  !name.startsWith('/') &&
  !name.split('/').some((part) => part === '..' || part === '.' || !part) &&
  !/(^|\/)(?:\.git|\.obsidian-vault|node_modules|data|server\.env|\.env|\.npmrc)(\/|$)|\.(?:sqlite.*|pem|key)$/.test(
    name,
  )
export const allowedPayload = (name) =>
  safePath(name) &&
  ([
    'package.json',
    'package-lock.json',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
    'deploy/compose.yaml',
    'deploy/release.Dockerfile',
  ].includes(name) ||
    name.startsWith('dist/') ||
    name.startsWith('dist-server/'))
export function pack(files) {
  const blocks = []
  for (const [name, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    assert(safePath(name), `归档路径不安全：${name}`)
    const buffer = Buffer.from(data),
      header = Buffer.alloc(512)
    header.write(name, 0, 100)
    for (const [offset, size, value] of [
      [100, 8, 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, buffer.length],
      [136, 12, 0],
    ])
      header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
      8,
    )
    blocks.push(header, buffer, Buffer.alloc((512 - (buffer.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 })
}
export function unpack(archive) {
  assert(archive.length <= 32 * 1024 * 1024, '压缩包超过允许大小')
  const data = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }),
    files = {}
  let offset = 0
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) {
      assert(
        data.subarray(offset).every((value) => value === 0),
        '归档含尾部隐藏内容',
      )
      return files
    }
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/s, '')
    const checksum = Number.parseInt(text(148, 8).trim(), 8)
    assert.equal(
      [...header].reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0),
      checksum,
      '归档头校验失败',
    )
    const name = text(0, 100),
      size = Number.parseInt(text(124, 12).trim(), 8)
    assert(safePath(name) && text(345, 155) === '', '拒绝不安全或带前缀的归档路径')
    assert(['0', ''].includes(text(156, 1)), '只接受普通文件，拒绝链接、目录或扩展归档头')
    assert(!Object.hasOwn(files, name), '归档含重复路径')
    assert(
      Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= data.length,
      '归档文件尺寸非法',
    )
    files[name] = Buffer.from(data.subarray(offset + 512, offset + 512 + size))
    assert(Object.keys(files).length < 1000, '归档文件过多')
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('归档结尾不完整')
}
export function verifyPackage(archive, expected) {
  assert.match(expected.sha256 ?? '', /^[a-f0-9]{64}$/, '必须提供独立记录的包 SHA-256')
  assert.equal(sha256(archive), expected.sha256, '包摘要不一致')
  const files = unpack(archive),
    manifest = JSON.parse(files['release-source.json']?.toString() ?? 'null')
  assert(manifest?.releaseProtocol === 1, '发布包协议不符')
  assert.equal(manifest.repository, 'yihannangua/mindme', '发布仓库不符')
  assert.equal(manifest.sha, expected.sha, '发布源码 SHA 不符')
  assert.equal(String(manifest.ci.runId), String(expected.ci), '发布 CI run 不符')
  assert.equal(manifest.ci.headSha, expected.sha, '发布 CI SHA 不符')
  assert.equal(manifest.ci.conclusion, 'success', '发布 CI 不成功')
  assert.equal(manifest.ci.repository, 'yihannangua/mindme', 'CI 仓库不符')
  assert.equal(manifest.ci.headBranch, 'main', 'CI 分支不符')
  assert.equal(manifest.ci.event, 'push', 'CI 事件不符')
  assert.equal(manifest.ci.path, '.github/workflows/ci.yml', 'CI 工作流不符')
  assert.equal(manifest.ci.status, 'completed', 'CI 尚未完成')
  assert(Number.isInteger(manifest.ci.attempt) && manifest.ci.attempt > 0, 'CI attempt 无效')
  const requiredJobs = ['类型、格式、测试与构建', '浏览器与 Node 后端回归', '容器构建与备份恢复']
  for (const name of requiredJobs)
    assert(
      manifest.ci.jobs.some((job) => job.name === name && job.conclusion === 'success'),
      `缺少成功 CI job：${name}`,
    )
  const names = Object.keys(files)
    .filter((name) => name !== 'release-source.json')
    .sort()
  assert.deepEqual(names, Object.keys(manifest.files).sort(), 'manifest 文件清单不一致')
  for (const name of names) {
    assert(allowedPayload(name), `不允许的产物文件：${name}`)
    assert.equal(sha256(files[name]), manifest.files[name].sha256, `文件摘要不一致：${name}`)
    assert.equal(files[name].length, manifest.files[name].bytes, `文件长度不一致：${name}`)
  }
  for (const name of [
    'dist/index.html',
    'dist-server/index.js',
    'dist-server/cli.js',
    'package.json',
    'package-lock.json',
    'deploy/release.Dockerfile',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
  ])
    assert(files[name], `缺少必要产物：${name}`)
  assert.equal(JSON.parse(files['package.json']).version, manifest.version, '包版本不一致')
  assert.equal(sha256(files['package-lock.json']), manifest.lockSha256, '锁文件摘要不一致')
  return { files, manifest }
}
