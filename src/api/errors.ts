export class CloudResponseError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'CloudResponseError'
  }
}
export async function responseError(
  response: Response,
  fallback: string,
): Promise<CloudResponseError> {
  const after = response.headers.get('retry-after'),
    seconds = Number(after)
  let wait = after
    ? Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(after) - Date.now())
    : 0
  if (!Number.isFinite(wait)) wait = 0
  let message = fallback,
    code: string | undefined
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      const body = (await response.json()) as { error?: unknown; code?: unknown }
      if (typeof body.code === 'string') code = body.code
      if (typeof body.error === 'string' && body.error.length <= 500) message = body.error
    } catch {
      /* 错误响应损坏时保留通用提示和重试时间。 */
    }
  }
  return new CloudResponseError(message, wait, code)
}
