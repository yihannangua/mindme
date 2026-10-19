import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// 只清理本次 mkdtemp 创建的沙箱；拒绝符号链接及其他临时目录。
export async function cleanupSandbox(path) {
  const parent = await realpath(tmpdir())
  assert.match(basename(path), /^mindme-release-rehearsal-[A-Za-z0-9]+$/, '临时沙箱名称非法')
  assert.equal(await realpath(dirname(path)), parent, '临时沙箱不在系统临时目录内')
  assert.equal((await lstat(path)).isSymbolicLink(), false, '拒绝清理符号链接沙箱')
  try {
    await rm(path, { recursive: true, force: false })
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error
    // root 创建的 release/0600 记录保留受限权限，仅在清理沙箱时提权。
    execFileSync(
      'sudo',
      [
        '-n',
        'python3',
        '-c',
        `
import pathlib,re,shutil,sys,tempfile
p=pathlib.Path(sys.argv[1])
assert re.fullmatch(r'mindme-release-rehearsal-[A-Za-z0-9]+',p.name)
assert p.parent.resolve()==pathlib.Path(tempfile.gettempdir()).resolve()
assert not p.is_symlink() and p.is_dir()
shutil.rmtree(p)
`,
        join(parent, basename(path)),
      ],
      { stdio: 'pipe' },
    )
  }
}
