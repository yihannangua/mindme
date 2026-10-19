import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

// 只在独立 Compose 项目和临时卷中演练，不读取现有部署配置或正式数据。
const project = `mindme-ci-${Date.now()}`
const environment = 'deploy/server.env'
try {
  await access(environment)
  throw new Error('已存在 deploy/server.env；为保护现有配置，请在干净克隆中运行')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const directory = await mkdtemp(join(tmpdir(), 'mindme-container-'))
const override = join(directory, 'override.yaml')
const base = 'http://localhost:8794'
const image = `mindme:${project}`
const restoredVolume = `${project}-restored`
const restoredContainer = `${project}-restored`
const env = { ...process.env, MINDME_RELEASE: project, MINDME_PORT: '8794' }
const docker = (args, capture = false) =>
  execFileSync('docker', args, { env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
const compose = (args, local = false, capture = false) =>
  docker(
    [
      'compose',
      '-p',
      project,
      '-f',
      'deploy/compose.yaml',
      ...(local ? ['-f', override] : []),
      ...args,
    ],
    capture,
  )
const dbSummary = `
  const { DatabaseSync } = require('node:sqlite');
  const { createHash } = require('node:crypto');
  const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
  const tables = ['maps','nodes','markers','tabs','passkeys','recovery_codes'];
  const content = Object.fromEntries(tables.map(table => [table,
    db.prepare('SELECT * FROM ' + table).all().map(row => JSON.stringify(row)).sort()]));
  const integrity = db.prepare('PRAGMA quick_check').get().quick_check;
  const counts = Object.fromEntries(tables.map(table => [table, content[table].length]));
  console.log(JSON.stringify({ integrity, counts, hash: createHash('sha256').update(JSON.stringify(content)).digest('hex') }));
  db.close();
`
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch {
      // 启动期间等待端口就绪，始终有总次数上限。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('容器健康检查超时')
}
let browser
let environmentCreated = false
try {
  await writeFile(
    environment,
    [
      'PUBLIC_ORIGIN=https://mindme.example',
      'AUTH_MODE=passkey',
      `SESSION_SECRET=${randomBytes(48).toString('base64url')}`,
      'MIGRATION_REQUIRED=true',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  )
  environmentCreated = true
  compose(['build'])
  compose(['up', '-d', '--wait', '--wait-timeout', '90'])
  assert.equal((await fetch(`${base}/api/ready`)).status, 503)
  // 生产配置先验证空库保护与初始化，令牌只留在当前进程内存中。
  compose(
    ['exec', '-T', 'mindme', 'node', 'dist-server/cli.js', 'passkey-setup', '--fresh'],
    false,
    true,
  )
  assert.equal((await fetch(`${base}/api/ready`)).status, 200)
  assert.equal((await fetch(`${base}/auth/session`).then((r) => r.json())).setupAvailable, true)
  const rejected = await fetch(`${base}/auth/dev-login`, {
    method: 'POST',
    headers: { origin: 'https://mindme.example' },
  })
  assert.notEqual(rejected.status, 200)
  // 虚拟认证器只在本机 HTTP 开发入口演练；生产安全边界另由上面的检查覆盖。
  await writeFile(
    override,
    `services:\n  mindme:\n    environment:\n      NODE_ENV: development\n      PUBLIC_ORIGIN: ${base}\n`,
  )
  compose(['up', '-d', '--wait', '--wait-timeout', '90'], true)
  const output = compose(
    ['exec', '-T', 'mindme', 'node', 'dist-server/cli.js', 'passkey-setup'],
    true,
    true,
  )
  const token = output.trim().split('\n').at(-1)
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  await page.goto(base)
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByLabel('首次设置令牌', { exact: true }).fill(token)
  await page.getByRole('button', { name: '创建 Passkey 并显示恢复码', exact: true }).click()
  await page.getByRole('status').getByText('Passkey 已添加', { exact: true }).waitFor()
  const codes = (await page.locator('.recovery-codes textarea').inputValue()).split('\n')
  assert.equal(codes.length, 10)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click()
  await page.getByText('已登录，修改会在本地保存后自动同步。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByLabel('离线恢复码', { exact: true }).fill(codes[0])
  await page.getByRole('button', { name: '使用恢复码登录', exact: true }).click()
  await page.getByRole('status').getByText('已通过离线恢复码登录', { exact: true }).waitFor()
  await page.getByLabel('关闭对话框').click()
  await page.getByRole('button', { name: '新建脑图', exact: true }).first().click()
  await page.getByLabel('脑图名称', { exact: true }).fill('容器备份演练')
  await page.getByRole('button', { name: '创建脑图', exact: true }).click()
  await page.getByRole('button', { name: '已同步', exact: true }).waitFor({ timeout: 20000 })
  await context.setOffline(true)
  const before = JSON.parse(compose(['exec', '-T', 'mindme', 'node', '-e', dbSummary], true, true))
  assert.equal(before.integrity, 'ok')
  assert.ok(before.counts.maps > 0 && before.counts.passkeys > 0)
  assert.equal(before.counts.recovery_codes, 9)
  compose(
    [
      'exec',
      '-T',
      'mindme',
      'node',
      'dist-server/cli.js',
      'backup',
      '/var/lib/mindme/backups/ci.sqlite',
    ],
    true,
    true,
  )
  compose(['stop'], true)
  docker(['volume', 'create', restoredVolume], true)
  // 恢复到新卷，原卷只读挂载，避免以覆盖原库的方式掩盖恢复问题。
  docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0',
    '-v',
    `${project}_mindme-data:/source:ro`,
    '-v',
    `${restoredVolume}:/restore`,
    '--entrypoint',
    'node',
    image,
    '-e',
    "const fs=require('node:fs');fs.copyFileSync('/source/backups/ci.sqlite','/restore/mindme.sqlite');fs.chownSync('/restore',1000,1000);fs.chownSync('/restore/mindme.sqlite',1000,1000)",
  ])
  docker(
    [
      'run',
      '-d',
      '--name',
      restoredContainer,
      '--env-file',
      environment,
      '-e',
      'NODE_ENV=development',
      '-e',
      `PUBLIC_ORIGIN=${base}`,
      '-p',
      '127.0.0.1:8794:3180',
      '-v',
      `${restoredVolume}:/var/lib/mindme`,
      image,
    ],
    true,
  )
  await waitForHealth()
  const after = JSON.parse(docker(['exec', restoredContainer, 'node', '-e', dbSummary], true))
  assert.deepEqual(after, before)
  await context.setOffline(false)
  await page.goto(base)
  await page.getByRole('button', { name: '已同步', exact: true }).waitFor({ timeout: 20000 })
  await page.getByRole('tab', { name: '容器备份演练', exact: true }).waitFor()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '账号与同步', exact: true }).click()
  await page.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click()
  await page.getByText('已登录，修改会在本地保存后自动同步。', { exact: true }).waitFor()
  console.log('容器演练通过：生产保护、空库初始化、Passkey/恢复码、独立卷备份恢复和恢复后登录。')
} finally {
  await browser?.close()
  for (const action of [
    () => docker(['rm', '-f', restoredContainer], true),
    () => compose(['down', '-v', '--remove-orphans'], false, true),
    () => docker(['volume', 'rm', restoredVolume], true),
  ]) {
    try {
      action()
    } catch {
      /* 测试早期失败时资源可能尚未创建。 */
    }
  }
  if (environmentCreated) await rm(environment)
  await rm(directory, { recursive: true, force: true })
}
