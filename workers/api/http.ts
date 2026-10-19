export const json = (data: unknown, status = 200, headers?: HeadersInit) => {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('cache-control', 'no-store')
  const response = Response.json(data, {
    status,
    headers: responseHeaders,
  })
  return response
}
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new Error('请求必须使用 application/json')
  if (Number(request.headers.get('content-length')) > maxBytes) throw new Error('请求超过容量上限')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('请求内容为空')
  const parts: Uint8Array[] = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxBytes) {
      await reader.cancel()
      throw new Error('请求超过容量上限')
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    throw new Error('请求 JSON 格式损坏')
  }
}
export function secureResponse(response: Response) {
  if (response.status === 101) return response
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; connect-src 'self' https://accounts.google.com/gsi/; frame-src https://accounts.google.com/gsi/; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  )
  if (response.headers.get('content-type')?.includes('text/html'))
    headers.set('cache-control', 'no-cache')
  return new Response(response.body, { status: response.status, headers })
}
