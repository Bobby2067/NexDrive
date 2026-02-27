const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function isLocalModeEnabled(): boolean {
  const raw = (process.env.NEXDRIVE_LOCAL_MODE ?? '').trim().toLowerCase()
  return TRUTHY_VALUES.has(raw)
}

export function getRuntimeMode(): 'local' | 'connected' {
  return isLocalModeEnabled() ? 'local' : 'connected'
}

export function isClerkConfigured(): boolean {
  const secret = process.env.CLERK_SECRET_KEY?.trim()
  const publishable = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()
  return Boolean(secret && publishable)
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown error'
}

const DEPENDENCY_ERROR_PATTERNS = [
  'database_url',
  'database is not configured',
  'upstash redis',
  'stripe is not configured',
  'stripe_secret_key',
  'clerk',
  'econnrefused',
  'enotfound',
  'fetch failed',
]

export function isDependencyError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase()
  return DEPENDENCY_ERROR_PATTERNS.some(pattern => message.includes(pattern))
}

export function dependencyPayload(error: unknown, dependency: string) {
  return {
    error: `${dependency} dependency is unavailable`,
    dependency,
    mode: getRuntimeMode(),
    details: toErrorMessage(error),
  }
}
