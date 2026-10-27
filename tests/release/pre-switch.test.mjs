import { execFileSync } from 'node:child_process'
import test from 'node:test'

test('切换前认证、数据库完整性和备份后内容变化必须核验', () => {
  const code = `
import importlib.util
spec = importlib.util.spec_from_file_location('release', 'scripts/release/remote-release.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
auth = {'configured': True, 'authMode': 'passkey', 'passkeyReady': True, 'setupAvailable': False}
backup = {'schema': 'schema', 'content': 'content', 'counts': {'maps': 1}}
live = {'integrity': 'ok', **backup}
assert module.validate_before_switch(auth, auth, live, backup)['databaseVerified'] is True
for changed_auth, changed_live in [
    ({**auth, 'passkeyReady': False}, live),
    (auth, {**live, 'integrity': 'broken'}),
    (auth, {**live, 'schema': 'changed'}),
    (auth, {**live, 'content': 'new-write'}),
    (auth, {**live, 'counts': {'maps': 0}}),
]:
    try:
        module.validate_before_switch(auth, changed_auth, changed_live, backup)
    except RuntimeError:
        continue
    raise AssertionError('不安全的候选状态未被阻止')
`
  execFileSync('python3', ['-c', code], { stdio: 'pipe' })
})
