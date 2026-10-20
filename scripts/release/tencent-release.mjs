import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  fullSha,
  githubCi,
  options,
  repository,
  run,
  sha256,
  verifyRepository,
  versions,
} from './provenance.mjs'
import { pack, verifyPackage } from './archive.mjs'

const [command, ...argv] = process.argv.slice(2)
const args = options(argv, [
  '--sha',
  '--ci-run',
  '--output',
  '--package',
  '--sha256',
  '--host',
  '--identity',
  '--known-hosts',
  '--root',
  '--server-env',
  '--data-dir',
  '--container',
  '--expected-image',
  '--expected-current',
  '--release',
  '--rollback-release',
  '--node-image',
  '--maintenance',
  '--mode',
])
const root = realpathSync(process.cwd())
verifyRepository(root)

async function proof() {
  return githubCi(fullSha(args['--sha']), args['--ci-run'])
}

function source(sha, directory) {
  const files = run('git', ['ls-tree', '-r', '--name-only', '-z', sha], { cwd: root })
    .split('\0')
    .filter(Boolean)
  const prefixes = ['src/', 'server/', 'shared/', 'workers/', 'public/']
  const fixed = [
    'package.json',
    'package-lock.json',
    'index.html',
    'tsconfig.json',
    'tsconfig.app.json',
    'tsconfig.server.json',
    'scripts/build-server.mjs',
    'scripts/offline-shell.mjs',
    'deploy/compose.yaml',
    'deploy/release.Dockerfile',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
  ]
  for (const name of files.filter(
    (file) => fixed.includes(file) || prefixes.some((prefix) => file.startsWith(prefix)),
  )) {
    const mode = run('git', ['ls-tree', sha, '--', name], { cwd: root }).slice(0, 6)
    assert.equal(mode, '100644', `构建源码拒绝符号链接或特殊模式：${name}`)
    const value = run('git', ['show', `${sha}:${name}`], { cwd: root, encoding: 'buffer' })
    mkdirSync(dirname(join(directory, name)), { recursive: true })
    writeFileSync(join(directory, name), value)
  }
}

function collect(directory, name, files) {
  const target = join(directory, name)
  const stat = lstatSync(target)
  assert(!stat.isSymbolicLink(), `编译产物拒绝符号链接：${name}`)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(target)) collect(directory, `${name}/${entry}`, files)
  } else {
    files[name] = readFileSync(target)
  }
}

function writeArtifact(output, archive, manifest, digest) {
  mkdirSync(output, { recursive: true, mode: 0o700 })
  writeFileSync(join(output, 'release.tar.gz'), archive, { flag: 'wx', mode: 0o600 })
  writeFileSync(join(output, 'release-source.json'), manifest, { flag: 'wx', mode: 0o600 })
  writeFileSync(join(output, 'SHA256SUMS'), `${digest}  release.tar.gz\n`, {
    flag: 'wx',
    mode: 0o600,
  })
}

if (command === 'package') {
  assert.equal(process.versions.node.split('.')[0], '24', '发布构建必须使用 Node.js 24')
  const sha = fullSha(args['--sha'])
  run('git', ['fetch', 'origin', 'main'], { cwd: root })
  run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: root })
  const ci = await proof()
  const directory = mkdtempSync(join(tmpdir(), 'mindme-release-'))
  try {
    source(sha, directory)
    const version = versions(directory)
    run('gitleaks', ['dir', directory, '--redact', '--no-banner'], { stdio: 'pipe' })
    const env = {
      ...process.env,
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    }
    for (const script of [['ci'], ['run', 'build'], ['run', 'build:server']])
      run('npm', script, { cwd: directory, env, stdio: 'inherit' })

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
      collect(directory, name, files)
    run('gitleaks', ['dir', join(directory, 'dist'), '--redact', '--no-banner'], { stdio: 'pipe' })
    run('gitleaks', ['dir', join(directory, 'dist-server'), '--redact', '--no-banner'], {
      stdio: 'pipe',
    })

    const manifest = {
      releaseProtocol: 1,
      repository,
      sha,
      tree: run('git', ['rev-parse', `${sha}^{tree}`], { cwd: root }).trim(),
      version,
      ci,
      toolSha: run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim(),
      toolchain: { node: process.version, npm: run('npm', ['--version']).trim() },
      lockSha256: sha256(files['package-lock.json']),
      files: Object.fromEntries(
        Object.entries(files).map(([name, buffer]) => [
          name,
          { bytes: buffer.length, sha256: sha256(buffer) },
        ]),
      ),
    }
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    files['release-source.json'] = manifestBuffer
    const archive = pack(files)
    const digest = sha256(archive)
    const output = resolve(args['--output'] ?? `release-artifacts/${sha}`)
    verifyPackage(archive, { sha, ci: ci.runId, sha256: digest })
    writeArtifact(output, archive, manifestBuffer, digest)
    console.log(JSON.stringify({ output, sha, version, ci: ci.runId, packageSha256: digest }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
} else if (['verify', 'deploy', 'rollback'].includes(command)) {
  const ci = await proof()
  assert(args['--package'], '缺少 --package')
  const archive = readFileSync(resolve(args['--package']))
  const { manifest } = verifyPackage(archive, {
    sha: args['--sha'],
    ci: ci.runId,
    sha256: args['--sha256'],
  })
  if (command === 'verify') {
    console.log(
      JSON.stringify({
        verified: true,
        sha: manifest.sha,
        version: manifest.version,
        packageSha256: args['--sha256'],
        ciRun: ci.runId,
      }),
    )
  } else {
    const mode = args['--mode'] ?? 'plan'
    assert(['plan', 'apply'].includes(mode), 'mode 只允许 plan/apply')
    if (mode === 'apply')
      assert(args['--maintenance'] === 'confirmed', '切换服务前必须显式 --maintenance confirmed')
    if (command === 'deploy')
      assert(
        /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(args['--release'] ?? ''),
        '必须提供安全且唯一的 --release 名称',
      )
    if (command === 'rollback')
      assert(
        /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(args['--rollback-release'] ?? ''),
        '必须提供已存在的 --rollback-release 名称',
      )
    const host = args['--host']
    assert(
      /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host ?? ''),
      '需要可信 SSH 目标 --host',
    )
    assert(
      args['--identity'] && args['--known-hosts'],
      '生产 SSH 必须显式指定私钥与已核验的 known_hosts 文件',
    )
    assert(
      args['--root'] &&
        args['--server-env'] &&
        args['--data-dir'] &&
        args['--container'] &&
        args['--expected-image'] &&
        args['--expected-current'],
      '缺少服务器私有路径、容器、预期 current 或预期旧镜像',
    )
    const config = {
      command,
      mode,
      sha: manifest.sha,
      version: manifest.version,
      packageSha256: args['--sha256'],
      ciRunId: ci.runId,
      root: resolve(args['--root']),
      serverEnv: resolve(args['--server-env']),
      dataDir: resolve(args['--data-dir']),
      container: args['--container'],
      expectedImage: args['--expected-image'],
      expectedCurrent: resolve(args['--expected-current']),
      release: args['--release'],
      rollbackRelease: args['--rollback-release'],
      nodeImage: args['--node-image'] ?? 'node:24-bookworm-slim',
      maintenance: args['--maintenance'],
    }
    const ssh = [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ConnectTimeout=10',
      ...(args['--identity'] ? ['-i', resolve(args['--identity'])] : []),
      ...(args['--known-hosts']
        ? ['-o', `UserKnownHostsFile=${resolve(args['--known-hosts'])}`]
        : []),
    ]
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
    let spool
    try {
      if (command === 'deploy' && mode === 'apply') {
        spool = run('ssh', [
          ...ssh,
          host,
          'umask 077; mktemp -d /tmp/mindme-release.XXXXXXXX',
        ]).trim()
        assert(/^\/tmp\/mindme-release\.[A-Za-z0-9]+$/.test(spool), '远程临时目录不合法')
        run('scp', [...ssh, resolve(args['--package']), `${host}:${spool}/release.tar.gz`], {
          stdio: 'inherit',
        })
        config.spool = spool
      }
      run(
        'ssh',
        [
          ...ssh,
          host,
          `sudo -n python3 - ${quote(Buffer.from(JSON.stringify(config)).toString('base64'))}`,
        ],
        {
          input: readFileSync(new URL('./remote-release.py', import.meta.url)),
          stdio: ['pipe', 'inherit', 'inherit'],
        },
      )
    } finally {
      if (spool)
        run(
          'ssh',
          [...ssh, host, `rm -f ${quote(`${spool}/release.tar.gz`)}; rmdir ${quote(spool)}`],
          {
            stdio: 'pipe',
          },
        )
    }
  }
} else {
  throw new Error(
    '用法：package|verify|deploy|rollback；必须绑定 --sha 完整 SHA、--ci-run 成功 main 运行 ID；验证/部署还需 --package 和 --sha256',
  )
}
