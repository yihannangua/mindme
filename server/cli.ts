import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { ServerDatabase } from './database'
import { PasskeyService } from './passkeys'
import { validateMigration, type MigrationSnapshot } from '../shared/state'
const [command, argument] = process.argv.slice(2)
const freshStart = command === 'passkey-setup' && argument === '--fresh'
const file = command === 'passkey-setup' ? undefined : argument
if (
  !['import', 'export', 'backup', 'inspect', 'passkey-setup'].includes(command ?? '') ||
  (!['inspect', 'passkey-setup'].includes(command ?? '') && !file) ||
  (command === 'passkey-setup' && argument !== undefined && !freshStart)
)
  throw new Error(
    '用法：node dist-server/cli.js import|export|backup 文件路径，inspect，passkey-setup [--fresh]；数据库由 DATABASE_PATH 指定',
  )
const database = new ServerDatabase(resolve(process.env.DATABASE_PATH ?? './data/mindme.sqlite'))
const requiredFile = () => {
  if (!file) throw new Error('缺少文件路径')
  return file
}
try {
  if (command === 'import') {
    const snapshot = JSON.parse(await readFile(requiredFile(), 'utf8')) as MigrationSnapshot
    validateMigration(snapshot)
    database.import(snapshot)
    console.log(
      JSON.stringify({
        result: '完整空间迁移成功',
        seq: snapshot.state.seq,
        maps: Object.keys(snapshot.state.space.maps).length,
      }),
    )
  }
  if (command === 'export') {
    const destination = requiredFile()
    if (database.db.prepare('SELECT 1 FROM passkeys LIMIT 1').get())
      throw new Error('数据库已启用 Passkey；空间迁移 JSON 不含认证凭据，请使用 SQLite 一致性备份')
    const text = JSON.stringify(database.export())
    await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 })
    await writeFile(destination, text, { mode: 0o600, flag: 'wx' })
    console.log(
      JSON.stringify({
        result: '完整空间已导出',
        bytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'),
      }),
    )
  }
  if (command === 'backup') {
    await database.backup(resolve(requiredFile()))
    console.log(JSON.stringify({ result: 'SQLite 一致性备份已完成' }))
  }
  if (command === 'inspect') {
    const state = database.export()
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        seq: state.state.seq,
        maps: Object.keys(state.state.space.maps).length,
        nodes: Object.values(state.state.space.maps).reduce(
          (sum, map) => sum + Object.keys(map.nodes).length,
          0,
        ),
        operations: Object.keys(state.state.results).length,
        sessions: state.sessions.length,
        passkeys: Number(
          (database.db.prepare('SELECT COUNT(*) AS count FROM passkeys').get() as { count: number })
            .count,
        ),
        recoveryCodes: Number(
          (
            database.db.prepare('SELECT COUNT(*) AS count FROM recovery_codes').get() as {
              count: number
            }
          ).count,
        ),
        bound: state.subject !== null,
      }),
    )
  }
  if (command === 'passkey-setup') {
    const origin = process.env.PUBLIC_ORIGIN
    if (!origin) throw new Error('必须配置 PUBLIC_ORIGIN')
    const passkeys = new PasskeyService(database, origin)
    const token = freshStart ? passkeys.createFreshAccountSetupToken() : passkeys.createSetupToken()
    console.log(
      `${freshStart ? '全新空白空间已初始化。旧云端数据及浏览器本地数据均未删除。' : '已迁移空间的 Passkey 首次设置令牌'}\n` +
        `令牌仅显示一次，15 分钟内使用：\n${token}`,
    )
  }
} finally {
  database.close()
}
