type DiagData = Record<string, unknown>

type DiagEntry = {
  ts: string
  scope: string
  event: string
  data?: unknown
}

const MAX_ENTRIES = 300
const entries: DiagEntry[] = []

const SENSITIVE_KEY = /(token|password|secret|authorization|jwt)/i
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

function redactValue(key: string, value: unknown): unknown {
  if (value == null) return value
  if (SENSITIVE_KEY.test(key)) {
    if (typeof value === 'string' && JWT_SHAPE.test(value)) {
      const described = describeJwt(value)
      return described?.decodeError ? '[redacted]' : described
    }
    return '[redacted]'
  }
  if (typeof value === 'string' && JWT_SHAPE.test(value)) {
    const described = describeJwt(value)
    return described?.decodeError ? value : described
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(key, item))
  if (typeof value === 'object') return redactObject(value as DiagData)
  return value
}

function redactObject(input: DiagData): DiagData {
  const out: DiagData = {}
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactValue(key, value)
  }
  return out
}

function decodeBase64UrlJson(segment: string): unknown {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return JSON.parse(atob(padded))
}

export function describeJwt(token: string | null | undefined): DiagData | null {
  if (!token) return null
  try {
    const payload = decodeBase64UrlJson(token.split('.')[1] ?? '') as {
      exp?: unknown
      iat?: unknown
      sub?: unknown
      role?: unknown
      aud?: unknown
    }
    const exp = typeof payload.exp === 'number' ? payload.exp : null
    const nowSec = Math.floor(Date.now() / 1000)
    return {
      kind: 'jwt',
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
      role: typeof payload.role === 'string' ? payload.role : undefined,
      aud: typeof payload.aud === 'string' ? payload.aud : undefined,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      exp,
      expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
      secondsUntilExpiry: exp ? exp - nowSec : null,
      expired: exp ? exp <= nowSec : null,
    }
  } catch {
    return { kind: 'jwt', decodeError: true }
  }
}

export function recordMqttDiag(scope: string, event: string, data?: unknown): void {
  const entry: DiagEntry = {
    ts: new Date().toISOString(),
    scope,
    event,
    data: data && typeof data === 'object' ? redactObject(data as DiagData) : data,
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  console.info(`[diag:${scope}] ${event}`, entry.data ?? '')
}

function readJsonLocalStorage(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function localStateSnapshot(): DiagData {
  if (typeof window === 'undefined') return {}
  const auth = (readJsonLocalStorage('teamclaw.session.v1') ??
    readJsonLocalStorage('teamclaw.auth.session.v1')) as {
    access_token?: string | null
    refresh_token?: string | null
    expires_at?: number | null
    user?: { id?: string | null; email?: string | null; is_anonymous?: boolean | null }
  } | null
  return {
    location: window.location.href,
    visibilityState: document.visibilityState,
    serverConfig: redactValue('serverConfig', readJsonLocalStorage('teamclaw.serverConfig')),
    currentTeam: redactValue('currentTeam', readJsonLocalStorage('teamclaw:current-team')),
    sessionListLastTeamId: window.localStorage.getItem('teamclaw.sessionList.lastTeamId'),
    authSession: auth
      ? {
          user: auth.user,
          accessToken: describeJwt(auth.access_token),
          refreshTokenPresent: Boolean(auth.refresh_token),
          expires_at: auth.expires_at,
        }
      : null,
  }
}

export function getMqttDiagSnapshot(extra?: DiagData): DiagData {
  return {
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
    localState: typeof window !== 'undefined' ? localStateSnapshot() : {},
    extra: extra ? redactObject(extra) : undefined,
    events: entries.slice(),
  }
}

async function copyMqttDiag(extra?: DiagData): Promise<string> {
  const text = JSON.stringify(getMqttDiagSnapshot(extra), null, 2)
  try {
    await navigator.clipboard.writeText(text)
    console.info('[diag:mqtt] copied diagnostic snapshot to clipboard')
  } catch (error) {
    console.warn('[diag:mqtt] clipboard write failed; returning text', error)
  }
  return text
}

declare global {
  interface Window {
    __teamclawMqttDiag?: () => DiagData
    __teamclawCopyMqttDiag?: () => Promise<string>
  }
}

if (typeof window !== 'undefined') {
  window.__teamclawMqttDiag = () => getMqttDiagSnapshot()
  window.__teamclawCopyMqttDiag = () => copyMqttDiag()
}
