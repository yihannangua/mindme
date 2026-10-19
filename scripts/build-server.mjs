import { build } from 'esbuild'
await build({
  entryPoints: ['server/index.ts', 'server/cli.ts'],
  outdir: 'dist-server',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
})
console.log('独立服务器构建完成：dist-server/index.js 与 cli.js')
