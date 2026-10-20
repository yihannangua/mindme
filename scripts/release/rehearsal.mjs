import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pack, verifyPackage } from './archive.mjs'
import { sha256 } from './provenance.mjs'
import { cleanupSandbox } from './sandbox.mjs'

const runId = String(process.env.GITHUB_RUN_ID || '1')
const ciJobs = ['类型、格式、测试与构建', '浏览器与 Node 后端回归', '容器构建与备份恢复']

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
}

async function collectFiles(root, name, files) {
  const path = join(root, name)
  const info = await lstat(path)
  assert.equal(info.isSymbolicLink(), false, `发布输入包含符号链接：${name}`)
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await collectFiles(root, `${name}/${entry}`, files)
  } else {
    files[name] = await readFile(path)
  }
}

async function makePackage(sourceRoot, sha) {
  const files = {}
  for (const name of [
    'package.json',
    'package-lock.json',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
    'deploy/compose.yaml',
    'deploy/release.Dockerfile',
    'dist',
    'dist-server',
  ])
    await collectFiles(sourceRoot, name, files)

  const version = JSON.parse(files['package.json'].toString()).version
  const ci = {
    repository: 'yihannangua/mindme',
    runId,
    attempt: 1,
    headSha: sha,
    headBranch: 'main',
    event: 'push',
    path: '.github/workflows/ci.yml',
    status: 'completed',
    conclusion: 'success',
    jobs: ciJobs.map((name) => ({ name, conclusion: 'success' })),
  }
  const manifest = {
    releaseProtocol: 1,
    repository: 'yihannangua/mindme',
    sha,
    tree: sha,
    version,
    ci,
    toolSha: sha,
    toolchain: { node: process.version, npm: 'release-rehearsal' },
    rehearsalOnly: true,
    lockSha256: sha256(files['package-lock.json']),
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        { bytes: content.length, sha256: sha256(content) },
      ]),
    ),
  }
  files['release-source.json'] = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const archive = pack(files)
  const packageSha256 = sha256(archive)
  verifyPackage(archive, { sha, ci: runId, sha256: packageSha256 })
  return { archive, manifest, packageSha256 }
}

function callRemote(sourceRoot, config) {
  return command(
    'sudo',
    [
      '-n',
      'python3',
      join(sourceRoot, 'scripts/release/remote-release.py'),
      Buffer.from(JSON.stringify(config)).toString('base64'),
    ],
    { stdio: 'inherit' },
  )
}

export async function runReleaseRehearsal() {
  const sourceRoot = await realpath(process.cwd())
  const sha = command('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot }).trim()
  assert.match(sha, /^[a-f0-9]{40}$/, '隔离演练需要完整源码 SHA')

  const scratch = await mkdtemp(join(tmpdir(), 'mindme-release-rehearsal-'))
  const root = join(scratch, 'server')
  const dataDir = join(scratch, 'database')
  const serverEnv = join(scratch, 'server.env')
  const spool = join(scratch, 'spool')
  const projectName = `mindme-release-ci-${randomBytes(6).toString('hex')}`
  const restoreVolume = `${projectName}-restored`
  const port = 18000 + (Number.parseInt(randomBytes(2).toString('hex'), 16) % 20000)
  const oldReleaseName = 'baseline'
  const newReleaseName = `candidate-${randomBytes(5).toString('hex')}`
  const oldImage = `mindme:${projectName}-baseline`
  const oldRelease = join(root, 'releases', oldReleaseName)
  const newRelease = join(root, 'releases', newReleaseName)
  const envSecret = randomBytes(48).toString('base64url')
  const oldEnv = join(oldRelease, 'deploy', '.env')
  const releaseEnv = {
    PUBLIC_ORIGIN: 'https://mindme.example',
    AUTH_MODE: 'passkey',
    SESSION_SECRET: envSecret,
    MIGRATION_REQUIRED: 'false',
  }
  const writeMarker = (value) =>
    `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DATABASE_PATH);d.prepare("INSERT INTO metadata(key,value) VALUES('releaseRehearsal',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run('${value}');d.close()`
  const readMarker =
    "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});console.log(d.prepare(\"SELECT value FROM metadata WHERE key='releaseRehearsal'\").get().value);d.close()"

  let composeCreated = false
  let originalError
  try {
    await mkdir(join(oldRelease, 'deploy'), { recursive: true, mode: 0o700 })
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    await mkdir(spool, { recursive: true, mode: 0o700 })
    await chmod(scratch, 0o700)
    command('sudo', ['-n', 'chown', '1000:1000', dataDir])
    await writeFile(
      serverEnv,
      `${Object.entries(releaseEnv)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
      { mode: 0o600 },
    )

    const oldCompose = (await readFile(join(sourceRoot, 'deploy/compose.yaml'), 'utf8')).replace(
      'context: ..',
      `context: ${sourceRoot}`,
    )
    await writeFile(
      join(oldRelease, 'package.json'),
      await readFile(join(sourceRoot, 'package.json')),
    )
    await writeFile(join(oldRelease, 'deploy/compose.yaml'), oldCompose)
    await writeFile(
      oldEnv,
      [
        `MINDME_RELEASE=${projectName}-baseline`,
        `MINDME_PORT=${port}`,
        `MINDME_DATA_DIR=${dataDir}`,
        `MINDME_SERVER_ENV=${serverEnv}`,
        'MINDME_DOCKERFILE=deploy/Dockerfile',
        'MINDME_NODE_IMAGE=node:24-bookworm-slim',
        '',
      ].join('\n'),
      { mode: 0o600 },
    )

    command(
      'sudo',
      [
        '-n',
        'docker',
        'compose',
        '--project-name',
        projectName,
        '--env-file',
        oldEnv,
        '-f',
        join(oldRelease, 'deploy/compose.yaml'),
        'build',
      ],
      { cwd: oldRelease, stdio: 'inherit' },
    )
    composeCreated = true
    command(
      'sudo',
      [
        '-n',
        'docker',
        'compose',
        '--project-name',
        projectName,
        '--env-file',
        oldEnv,
        '-f',
        join(oldRelease, 'deploy/compose.yaml'),
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '90',
      ],
      { cwd: oldRelease, stdio: 'inherit' },
    )
    const oldContainer = command('sudo', [
      '-n',
      'docker',
      'compose',
      '--project-name',
      projectName,
      '--env-file',
      oldEnv,
      '-f',
      join(oldRelease, 'deploy/compose.yaml'),
      'ps',
      '-q',
      'mindme',
    ]).trim()
    assert(oldContainer, '隔离基线容器没有启动')
    command('sudo', [
      '-n',
      'docker',
      'exec',
      oldContainer,
      'node',
      '-e',
      writeMarker(`before-${sha.slice(0, 12)}`),
    ])
    await mkdir(root, { recursive: true, mode: 0o700 })
    await command('ln', ['-s', oldRelease, join(root, 'current')])

    const { archive, manifest, packageSha256 } = await makePackage(sourceRoot, sha)
    await writeFile(join(spool, 'release.tar.gz'), archive, { mode: 0o600 })
    const common = {
      root,
      serverEnv,
      dataDir,
      container: oldContainer,
      expectedImage: oldImage,
      expectedCurrent: oldRelease,
      sha,
      version: manifest.version,
      packageSha256,
      ciRunId: runId,
      release: newReleaseName,
      nodeImage: 'node:24-bookworm-slim',
      projectName,
      port,
      rehearsal: true,
      sandbox: scratch,
      maintenance: 'confirmed',
    }

    callRemote(sourceRoot, {
      ...common,
      command: 'deploy',
      mode: 'apply',
      spool,
    })

    const deployment = JSON.parse(
      command('sudo', ['-n', 'cat', join(newRelease, 'deployment-record.json')]),
    )
    assert.equal(deployment.sourceSha, sha)
    assert.equal(deployment.packageSha256, packageSha256)
    assert.equal(deployment.backup.mode, '600')
    assert.equal(deployment.backup.quickCheck, 'ok')
    assert.equal(deployment.backup.restored, true)
    assert.equal(deployment.backup.compatible, true)
    assert.equal(
      Number(command('sudo', ['-n', 'stat', '-c', '%s', deployment.backup.path]).trim()),
      deployment.backup.size,
    )
    const candidateImage = `mindme:${newReleaseName}`
    const candidateImageId = command('sudo', [
      '-n',
      'docker',
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      candidateImage,
    ]).trim()
    assert.equal(candidateImageId, deployment.imageId)
    const imageEnv = command('sudo', [
      '-n',
      'docker',
      'image',
      'inspect',
      '--format',
      '{{json .Config.Env}}',
      candidateImage,
    ])
    const imageHistory = command('sudo', ['-n', 'docker', 'history', '--no-trunc', candidateImage])
    assert.equal(imageEnv.includes(envSecret), false, '私有配置值进入镜像环境')
    assert.equal(imageHistory.includes(envSecret), false, '私有配置值进入镜像层')

    command('docker', ['volume', 'create', restoreVolume])
    command('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '0',
      '-v',
      `${deployment.backup.path}:/source/backup.sqlite:ro`,
      '-v',
      `${restoreVolume}:/restore`,
      '--entrypoint',
      'node',
      candidateImage,
      '-e',
      "const fs=require('node:fs');fs.copyFileSync('/source/backup.sqlite','/restore/mindme.sqlite');fs.chownSync('/restore',1000,1000);fs.chmodSync('/restore',0o700);fs.chownSync('/restore/mindme.sqlite',1000,1000);fs.chmodSync('/restore/mindme.sqlite',0o600)",
    ])
    // SQLite WAL 模式可能创建 SHM/WAL；仅恢复副本卷可写，源备份始终只读。
    const restored = command('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-v',
      `${restoreVolume}:/restore`,
      '--entrypoint',
      'node',
      candidateImage,
      '-e',
      "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/restore/mindme.sqlite',{readOnly:true});const check=d.prepare('PRAGMA quick_check').get().quick_check;const value=d.prepare(\"SELECT value FROM metadata WHERE key='releaseRehearsal'\").get().value;d.close();if(check!=='ok'||!value)process.exit(2);console.log(JSON.stringify({check,value}))",
    ])
    assert.deepEqual(JSON.parse(restored), {
      check: 'ok',
      value: `before-${sha.slice(0, 12)}`,
    })

    const candidateContainer = command('sudo', [
      '-n',
      'docker',
      'compose',
      '--project-name',
      projectName,
      '--env-file',
      join(newRelease, 'deploy/.env'),
      '-f',
      join(newRelease, 'deploy/compose.yaml'),
      'ps',
      '-q',
      'mindme',
    ]).trim()
    const newWrite = `after-${randomBytes(8).toString('hex')}`
    command('sudo', [
      '-n',
      'docker',
      'exec',
      candidateContainer,
      'node',
      '-e',
      writeMarker(newWrite),
    ])

    callRemote(sourceRoot, {
      ...common,
      command: 'rollback',
      mode: 'apply',
      container: candidateContainer,
      expectedCurrent: newRelease,
      expectedImage: candidateImage,
      rollbackRelease: oldReleaseName,
    })

    assert.equal(await realpath(join(root, 'current')), await realpath(oldRelease))
    const rolledBackContainer = command('sudo', [
      '-n',
      'docker',
      'compose',
      '--project-name',
      projectName,
      '--env-file',
      oldEnv,
      '-f',
      join(oldRelease, 'deploy/compose.yaml'),
      'ps',
      '-q',
      'mindme',
    ]).trim()
    assert.equal(
      command('sudo', [
        '-n',
        'docker',
        'inspect',
        '--format',
        '{{.Image}}',
        rolledBackContainer,
      ]).trim(),
      command('sudo', ['-n', 'docker', 'image', 'inspect', '--format', '{{.Id}}', oldImage]).trim(),
    )
    assert.equal(
      command('sudo', [
        '-n',
        'docker',
        'exec',
        rolledBackContainer,
        'node',
        '-e',
        readMarker,
      ]).trim(),
      newWrite,
    )
    console.log(
      '发布执行器演练通过：真实 deploy/rollback 入口、来源标签、配置隔离、SQLite 备份与回滚后写入保留。',
    )
  } catch (error) {
    originalError = error
    throw error
  } finally {
    if (composeCreated) {
      try {
        command(
          'sudo',
          [
            '-n',
            'docker',
            'compose',
            '--project-name',
            projectName,
            '--env-file',
            join(newRelease, 'deploy/.env'),
            '-f',
            join(newRelease, 'deploy/compose.yaml'),
            'down',
            '--remove-orphans',
          ],
          { stdio: 'pipe' },
        )
      } catch {
        try {
          command(
            'sudo',
            [
              '-n',
              'docker',
              'compose',
              '--project-name',
              projectName,
              '--env-file',
              oldEnv,
              '-f',
              join(oldRelease, 'deploy/compose.yaml'),
              'down',
              '--remove-orphans',
            ],
            { stdio: 'pipe' },
          )
        } catch {
          // 测试已失败时清理仍尽量限制在本次随机 Compose 项目。
        }
      }
    }
    try {
      command('docker', ['volume', 'rm', restoreVolume], { stdio: 'pipe' })
    } catch {
      // 清理仅针对本次随机命名的恢复演练卷。
    }
    try {
      await cleanupSandbox(scratch)
    } catch (cleanupError) {
      if (originalError)
        throw new AggregateError([originalError, cleanupError], '隔离演练和临时目录清理均失败')
      throw cleanupError
    }
  }
}
