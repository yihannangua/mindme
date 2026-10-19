import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const repository = 'yihannangua/mindme'
export const requiredJobNames = [
  '类型、格式、测试与构建',
  '浏览器与 Node 后端回归',
  '容器构建与备份恢复',
]
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options })
export function fullSha(value) {
  assert.match(value ?? '', /^[a-f0-9]{40}$/, '必须提供完整的 40 位提交 SHA')
  return value
}
export function options(argv, allowed) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    assert(allowed.includes(key) && !Object.hasOwn(result, key), `未知或重复参数：${key}`)
    assert(argv[index + 1] && !argv[index + 1].startsWith('--'), `参数缺值：${key}`)
    result[key] = argv[index + 1]
  }
  return result
}
export function validateCi(ci, jobs, sha, expectedRunId) {
  fullSha(sha)
  assert.equal(String(ci.id), String(expectedRunId), 'CI run ID 不符')
  assert.equal(ci.repository?.full_name, repository, 'CI 仓库不符')
  assert.equal(ci.head_repository?.full_name, repository, 'CI 来源仓库不符')
  assert.equal(ci.head_sha, sha, 'CI head_sha 必须与源码完整 SHA 相同')
  assert.equal(ci.head_branch, 'main', '必须使用合并后 main 的 CI')
  assert.equal(ci.event, 'push', 'PR 或手动运行不能冒充 main push CI')
  assert.equal(ci.path, '.github/workflows/ci.yml', 'CI 工作流路径不符')
  assert.equal(ci.status, 'completed', 'CI 尚未完成')
  assert.equal(ci.conclusion, 'success', 'CI 未成功')
  const checks = Object.values(jobs ?? {})
  assert(checks.length >= requiredJobNames.length, '缺少必要 CI 作业')
  assert(
    checks.every((job) => job.status === 'completed' && job.conclusion === 'success'),
    'CI 含失败、跳过或未完成作业',
  )
  // GitHub REST 返回作业显示名，必须核对三种实际检查，不接受空作业列表。
  for (const name of requiredJobNames)
    assert(
      checks.some((job) => job.name === name),
      `缺少 CI 检查：${name}`,
    )
  return {
    repository: ci.repository.full_name,
    runId: ci.id,
    attempt: ci.run_attempt,
    headSha: ci.head_sha,
    headBranch: ci.head_branch,
    event: ci.event,
    path: ci.path,
    status: ci.status,
    url: ci.html_url,
    conclusion: ci.conclusion,
    jobs: checks.map(({ name, conclusion }) => ({ name, conclusion })),
  }
}
export async function githubCi(sha, runId) {
  fullSha(sha)
  assert.match(String(runId), /^[1-9][0-9]*$/, 'CI run ID 非法')
  return fetchCi(sha, runId)
}
export async function fetchCi(sha, runId, token = process.env.GITHUB_TOKEN) {
  fullSha(sha)
  assert.match(String(runId), /^[1-9][0-9]*$/, 'CI run ID 非法')
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  const request = async (url) => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
    assert(response.ok, `GitHub API 请求失败：${response.status} ${url}`)
    return response.json()
  }
  const [ci, main] = await Promise.all([
    request(`https://api.github.com/repos/${repository}/actions/runs/${runId}`),
    request(`https://api.github.com/repos/${repository}/commits/main`),
  ])
  assert.equal(main.sha, sha, '指定 SHA 不是当前公开 main，拒绝生成发布包')
  assert(Number.isInteger(ci.run_attempt) && ci.run_attempt > 0, 'CI run attempt 无效')
  const jobs = await request(
    `https://api.github.com/repos/${repository}/actions/runs/${runId}/attempts/${ci.run_attempt}/jobs?per_page=100`,
  )
  return validateCi(ci, jobs.jobs, sha, runId)
}
export function verifyRepository(root) {
  assert.equal(
    run('git', ['rev-parse', '--show-toplevel'], { cwd: root }).trim(),
    root,
    '必须在公开仓库根目录执行',
  )
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: root }).trim()
  assert(
    [`https://github.com/${repository}.git`, `git@github.com:${repository}.git`].includes(remote),
    '公开远程仓库不符',
  )
  assert.equal(
    run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root }).trim(),
    '',
    '已跟踪源码或工具存在未提交改动',
  )
}
export function versions(root) {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'))
  const lock = JSON.parse(readFileSync(`${root}/package-lock.json`, 'utf8'))
  const source = readFileSync(`${root}/src/version.ts`, 'utf8')
  assert.equal(lock.version, pkg.version, '锁文件版本不一致')
  assert.equal(lock.packages[''].version, pkg.version, '锁文件根包版本不一致')
  assert(source.includes(`APP_VERSION = '${pkg.version}'`), '运行时版本不一致')
  return pkg.version
}
