import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const assets = (await readdir(new URL('../dist/assets/', import.meta.url)))
  .filter((file) => /\.(js|css)$/.test(file))
  .map((file) => `/assets/${file}`)
const index = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
const id = createHash('sha256').update(index).digest('hex').slice(0, 12)
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8')
await writeFile(
  new URL('../dist/sw.js', import.meta.url),
  source
    .replace('__BUILD_ID__', id)
    .replace('/*__PRECACHE__*/ []', JSON.stringify(['/', ...assets])),
)
console.log(`离线应用壳已生成：${assets.length + 1} 个资源，版本 ${id}`)
