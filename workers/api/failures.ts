import { json } from './http'
export function storageFailure(error: unknown, now = Date.now()): Response | null {
  const message = error instanceof Error ? error.message : String(error)
  const write = /Exceeded allowed rows written.*free tier/i.test(message)
  const read = /Exceeded allowed rows read.*free tier/i.test(message)
  if (!write && !read) return null
  const retryAt = (Math.floor(now / 86400000) + 1) * 86400000
  const when = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(retryAt)
  return json(
    {
      error: `云端免费套餐今日${write ? '写入' : '读取'}额度已用尽，预计北京时间 ${when} 重置；本地修改仍保留，届时自动重试。`,
      code: write ? 'STORAGE_WRITE_QUOTA' : 'STORAGE_READ_QUOTA',
      retryAt,
    },
    429,
    { 'Retry-After': String(Math.max(1, Math.ceil((retryAt - now) / 1000))) },
  )
}
