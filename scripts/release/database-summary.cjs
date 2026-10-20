const { DatabaseSync } = require('node:sqlite')
const { createHash } = require('node:crypto')

const path = process.argv[2] || process.env.DATABASE_PATH
const database = new DatabaseSync(path, { readOnly: true })
// 同一只读事务中逐行计算摘要，避免复制整库历史并确保跨表视图一致。
database.exec('PRAGMA temp_store=FILE; PRAGMA cache_size=-4096; BEGIN')
const schema = database
  .prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  )
  .all()
const tables = schema.filter((item) => item.type === 'table').map((item) => item.name)
const content = Object.create(null)

for (const table of tables) {
  const quote = (value) => `"${value.replaceAll('"', '""')}"`
  const name = quote(table)
  const columns = database
    .prepare(`PRAGMA table_xinfo(${name})`)
    .all()
    .filter((column) => column.hidden === 0)
    .map((column) => quote(column.name))
  const order = columns.map((column) => `${column} COLLATE BINARY`).join(',')
  const rows = database.prepare(`SELECT * FROM ${name} ORDER BY ${order}`).iterate()
  const digest = createHash('sha256')
  let count = 0

  for (const row of rows) {
    const encoded = JSON.stringify(row)
    digest.update(String(Buffer.byteLength(encoded)))
    digest.update(':')
    digest.update(encoded)
    digest.update('\n')
    count++
  }

  content[table] = { count, sha256: digest.digest('hex') }
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const result = {
  integrity: database.prepare('PRAGMA quick_check').get().quick_check,
  schema: hash(schema),
  content: hash(content),
  counts: Object.fromEntries(Object.entries(content).map(([name, value]) => [name, value.count])),
}

database.exec('COMMIT')
database.close()
if (result.integrity !== 'ok') process.exit(2)
console.log(JSON.stringify(result))
