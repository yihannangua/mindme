import { DOMParser } from '@xmldom/xmldom'
import { unzipSync } from 'fflate'
import { assert, type Markers } from '../domain/types'
import type { DraftNode, ImportResult } from './outline'
const limits = { fileBytes: 20 * 1024 * 1024, xmlBytes: 16 * 1024 * 1024, nodes: 5000, depth: 128 }
function fail(message: string): never {
  throw new Error(message)
}
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

// 先检查 ZIP 目录，只解压内容文件，不展开附件；核对长度与 CRC，避免接受损坏内容。
export function extractContent(bytes: Uint8Array): string {
  if (bytes.length < 22) fail('文件损坏，无法读取 XMind 压缩包')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--)
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break
  if (end < Math.max(0, bytes.length - 65557)) fail('文件损坏，无法读取 XMind 压缩包目录')
  const count = view.getUint16(end + 10, true),
    directory = view.getUint32(end + 16, true),
    directorySize = view.getUint32(end + 12, true)
  if (
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 8, true) !== count
  )
    fail('暂不支持分卷 XMind 文件')
  if (count === 65535 || directory === 0xffffffff || directorySize === 0xffffffff)
    fail('暂不支持 ZIP64 XMind 文件')
  if (directory + directorySize > end) fail('XMind 压缩包目录损坏')
  let offset = directory,
    content: { original: number; crc: number } | null = null,
    modern = false
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directory + directorySize || view.getUint32(offset, true) !== 0x02014b50)
      fail('XMind 压缩包目录损坏')
    const nameLength = view.getUint16(offset + 28, true),
      extraLength = view.getUint16(offset + 30, true),
      commentLength = view.getUint16(offset + 32, true)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > directory + directorySize) fail('XMind 压缩包目录损坏')
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    if (name === 'content.json') modern = true
    if (name === 'content.xml') {
      if (content) fail('XMind 文件包含重复的 content.xml')
      const compressed = view.getUint32(offset + 20, true),
        original = view.getUint32(offset + 24, true),
        local = view.getUint32(offset + 42, true),
        method = view.getUint16(offset + 10, true)
      if (view.getUint16(offset + 8, true) & 1) fail('暂不支持加密的 XMind 文件')
      if (original > limits.xmlBytes || compressed > limits.fileBytes)
        fail('XMind 内容过大，请拆分后导入')
      if (method !== 0 && method !== 8) fail('XMind 使用了不支持的压缩方式')
      if (local + 30 > directory || view.getUint32(local, true) !== 0x04034b50)
        fail('XMind 内容文件头损坏')
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      if (
        start + compressed > directory ||
        view.getUint16(local + 8, true) !== method ||
        view.getUint16(local + 6, true) & 1
      )
        fail('XMind 内容文件数据损坏')
      const localName = new TextDecoder().decode(
        bytes.subarray(local + 30, local + 30 + view.getUint16(local + 26, true)),
      )
      if (localName !== name) fail('XMind 内容文件名与目录不一致')
      content = { original, crc: view.getUint32(offset + 16, true) }
    }
    offset = next
  }
  if (offset !== directory + directorySize) fail('XMind 压缩包目录损坏')
  if (!content)
    fail(
      modern
        ? '这是新版 XMind 格式，目前支持 XMind 8 的 content.xml 格式'
        : '文件缺少 content.xml，无法识别为 XMind 8 文件',
    )
  let xml: Uint8Array
  try {
    xml = unzipSync(bytes, { filter: (entry) => entry.name === 'content.xml' })['content.xml']
  } catch {
    fail('XMind 压缩内容损坏，解压失败')
  }
  if (!xml || xml.length !== content.original || crc32(xml) !== content.crc)
    fail('XMind 内容校验失败，文件可能已损坏')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(xml)
  } catch {
    fail('XMind 内容不是有效的 UTF-8 文字')
  }
}

type XmlElement = NonNullable<ReturnType<DOMParser['parseFromString']>>['documentElement']
const elements = (parent: XmlElement | undefined) =>
  Array.from(parent?.childNodes ?? []).filter(
    (child) => child.nodeType === 1,
  ) as NonNullable<XmlElement>[]
const direct = (parent: XmlElement | undefined, name: string) =>
  elements(parent).filter((child) => child.localName === name || child.nodeName === name)
const child = (parent: XmlElement | undefined, name: string) => direct(parent, name)[0]
export function markerFromXmind(id: string, ignored: Set<string>): [keyof Markers, string] | null {
  const known: Record<string, [keyof Markers, string]> = {
    'priority-1': ['priority', '①'],
    'priority-2': ['priority', '②'],
    'priority-3': ['priority', '③'],
    'priority-4': ['priority', '④'],
    'task-start': ['progress', 'start'],
    'task-oct': ['progress', '1/8'],
    'task-quarter': ['progress', '2/8'],
    'task-3oct': ['progress', '3/8'],
    'task-half': ['progress', '4/8'],
    'task-5oct': ['progress', '5/8'],
    'task-3quar': ['progress', '6/8'],
    'task-7oct': ['progress', '7/8'],
    'task-done': ['progress', 'done'],
  }
  for (const color of ['red', 'orange', 'blue', 'green', 'purple', 'teal', 'gray'])
    known[`flag-${color}`] = ['flag', color]
  known['flag-yellow'] = ['flag', 'orange']
  if (Object.hasOwn(known, id)) return known[id]
  ignored.add(id || '未命名标记')
  return null
}
export function parseXmindContent(xml: string): ImportResult {
  assert(xml.trim() && xml.length <= limits.xmlBytes, 'XMind 内容为空或超过 16 MiB')
  assert(!/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml), '不支持 XML 文档类型或实体声明')
  let invalid = false
  let doc: ReturnType<DOMParser['parseFromString']>
  try {
    doc = new DOMParser({
      onError: () => {
        invalid = true
      },
    }).parseFromString(xml, 'application/xml')
  } catch {
    throw new Error('content.xml 格式损坏')
  }
  assert(
    !invalid &&
      doc?.documentElement &&
      (doc.documentElement.localName === 'xmap-content' ||
        doc.documentElement.nodeName === 'xmap-content'),
    'content.xml 格式损坏或不是 XMind 8 文件',
  )
  const sheets = direct(doc.documentElement, 'sheet'),
    drafts: ImportResult['drafts'] = [],
    ignored = new Set<string>(),
    warnings = new Set<string>()
  assert(sheets.length, '文件没有可导入的脑图')
  let count = 0
  for (const sheet of sheets) {
    const roots = direct(sheet, 'topic'),
      nodes: DraftNode[] = [],
      seen = new Set<string>()
    assert(roots.length === 1, '脑图缺少唯一的中心主题')
    function visit(topic: NonNullable<XmlElement>, parentId: string | null, depth: number) {
      assert(depth <= limits.depth && ++count <= limits.nodes, '导入最多支持 5000 个节点和 128 层')
      const sourceId = topic.getAttribute('id')
      assert(!sourceId || !seen.has(sourceId), '文件包含重复的节点标识')
      if (sourceId) seen.add(sourceId)
      const id = `xmind-${nodes.length}`,
        text = child(topic, 'title')?.textContent ?? '',
        markers: Markers = {}
      for (const group of ['markers', 'marker-refs'])
        for (const ref of direct(child(topic, group), 'marker-ref')) {
          const marker = markerFromXmind(ref.getAttribute('marker-id') ?? '', ignored)
          if (marker) {
            if (markers[marker[0]]) warnings.add('同类多个标记保留最后一项')
            markers[marker[0]] = marker[1]
          }
        }
      nodes.push({
        id,
        parentId,
        text: parentId === null ? text.trim() || '未命名脑图' : text,
        markers,
        collapsed: topic.getAttribute('branch') === 'folded',
      })
      for (const group of direct(child(topic, 'children'), 'topics')) {
        if (group.getAttribute('type') && group.getAttribute('type') !== 'attached')
          warnings.add('自由或概要主题保留层级并自动布局，未保留原坐标')
        for (const nested of direct(group, 'topic')) visit(nested, id, depth + 1)
      }
    }
    visit(roots[0], null, 0)
    drafts.push({ title: nodes[0].text, nodes })
  }
  if (ignored.size) warnings.add(`忽略无法识别的标记：${[...ignored].join('、')}`)
  return { drafts, warnings: [...warnings] }
}
export async function parseXmindFile(file: {
  name: string
  size: number
  arrayBuffer: () => Promise<ArrayBuffer>
}): Promise<ImportResult> {
  assert(
    /\.xmind$/i.test(file.name) && file.size > 0 && file.size <= limits.fileBytes,
    '请选择非空且不超过 20 MiB 的 .xmind 文件',
  )
  let buffer: ArrayBuffer
  try {
    buffer = await file.arrayBuffer()
  } catch {
    throw new Error('无法读取文件，请重新选择')
  }
  const bytes = new Uint8Array(buffer)
  assert(bytes.length <= limits.fileBytes, '文件超过 20 MiB')
  return parseXmindContent(extractContent(bytes))
}
