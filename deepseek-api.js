/**
 * Pure DeepSeek Search HTTP client.
 *
 * No Cordis / DSH imports and no npm dependencies, so the whole module is
 * unit-testable with an injected `fetchImpl` (see test/deepseek-api.test.mjs).
 *
 * Upstream contract: POST https://api.deepseek.com/v1/tools/search
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_COUNT = 10
const MIN_COUNT = 1
const MAX_COUNT = 50
const MAX_QUERY_LENGTH = 128
const DEFAULT_TIMEOUT_MS = 25000
const SEARCH_PATH = '/v1/tools/search'
// Kept as a constant so the literal authorization header value never has to be
// assembled inline with a key at the call site.
const AUTHORIZATION_SCHEME = 'Bearer'

const FALLBACK_MESSAGES = {
  UNAUTHORIZED: 'the API key was rejected — check the key in the DeepSeek Search panel',
  INSUFFICIENT_BALANCE: 'the DeepSeek account has insufficient balance',
  FORBIDDEN: 'the request was blocked',
  NOT_FOUND: 'the search endpoint is unavailable',
  TIMEOUT: 'the upstream request timed out',
  RATE_LIMITED: 'too many requests — retry after a short pause',
  BAD_REQUEST: 'the request was rejected',
  SERVER_ERROR: 'the upstream service failed',
  NETWORK_ERROR: 'the network request failed',
  BAD_RESPONSE: 'the upstream response was not understood',
}

/** Error type carrying a stable machine code and (when known) the HTTP status. */
export class DeepSeekSearchError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'DeepSeekSearchError'
    this.code = code
    this.status = status
  }
}

/** Clamp `value` to an integer in 1..50, falling back to `fallback` (default 10). */
export function clampCount(value, fallback = DEFAULT_COUNT) {
  const base = toFiniteInteger(fallback, DEFAULT_COUNT)
  const count = toFiniteInteger(value, base)
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, count))
}

/** Normalise a base URL: trim, drop trailing slashes, default to the public API. */
export function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return DEFAULT_BASE_URL
  const stripped = raw.replace(/\/+$/, '')
  return stripped || DEFAULT_BASE_URL
}

/** Mask a key for display: first 6 + last 4 characters, e.g. `abcd12…ef34`. */
export function maskKey(key) {
  const value = typeof key === 'string' ? key.trim() : ''
  if (!value) return ''
  if (value.length <= 4) return '…'
  if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

/** Build the upstream JSON body from the camelCase tool/route input. */
export function buildSearchRequest(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const body = {
    query: typeof source.query === 'string' ? source.query.trim() : '',
    count: clampCount(source.count),
    need_content: source.needContent === true,
  }
  const oriQuestion = typeof source.oriQuestion === 'string' ? source.oriQuestion.trim() : ''
  if (oriQuestion) body.ori_question = oriQuestion.slice(0, MAX_QUERY_LENGTH)
  const localization = typeof source.localization === 'string' ? source.localization.trim() : ''
  if (localization) body.localization = localization
  return body
}

/**
 * Search the web through the standalone DeepSeek Search API.
 *
 * Resolves to `{ results, elapsedMs }`; every failure is a DeepSeekSearchError
 * whose message never contains the API key.
 */
export async function searchDeepSeek({
  apiKey,
  baseUrl,
  query,
  count,
  needContent,
  oriQuestion,
  localization,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  fetchImpl = fetch,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) {
    throw new DeepSeekSearchError('MISSING_API_KEY', 'DeepSeek Search API key is not configured.')
  }

  const trimmedQuery = typeof query === 'string' ? query.trim() : ''
  if (!trimmedQuery) {
    throw new DeepSeekSearchError('BAD_REQUEST', 'DeepSeek Search query must be a non-empty string.')
  }
  const queryLength = Array.from(trimmedQuery).length
  if (queryLength > MAX_QUERY_LENGTH) {
    throw new DeepSeekSearchError(
      'BAD_REQUEST',
      `DeepSeek Search query must be at most ${MAX_QUERY_LENGTH} characters (got ${queryLength}).`,
    )
  }

  const effectiveTimeout = toTimeout(timeoutMs)
  const payload = buildSearchRequest({ query: trimmedQuery, count, needContent, oriQuestion, localization })
  const url = `${normalizeBaseUrl(baseUrl)}${SEARCH_PATH}`
  const timeoutSignal = AbortSignal.timeout(effectiveTimeout)
  const requestSignal = signal ? combineSignals([signal, timeoutSignal]) : timeoutSignal
  const startedAt = Date.now()

  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `${AUTHORIZATION_SCHEME} ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: requestSignal,
    })
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw new DeepSeekSearchError('TIMEOUT', `DeepSeek Search request timed out after ${effectiveTimeout}ms.`)
    }
    if (signal && signal.aborted) {
      throw new DeepSeekSearchError('NETWORK_ERROR', 'DeepSeek Search request was cancelled.')
    }
    throw new DeepSeekSearchError(
      'NETWORK_ERROR',
      redact(`DeepSeek Search request failed: ${messageOf(error)}`, key),
    )
  }

  if (!response || typeof response !== 'object') {
    throw new DeepSeekSearchError('BAD_RESPONSE', 'DeepSeek Search returned no response object.')
  }

  if (!response.ok) {
    const body = await readResponseBody(response)
    const described = describeError(response.status, body)
    throw new DeepSeekSearchError(described.code, redact(described.message, key), response.status)
  }

  let data
  try {
    data = await response.json()
  } catch {
    throw new DeepSeekSearchError(
      'BAD_RESPONSE',
      'DeepSeek Search returned a response that is not valid JSON.',
      response.status,
    )
  }

  const rawResults = data && typeof data === 'object' && Array.isArray(data.results) ? data.results : null
  if (!rawResults) {
    throw new DeepSeekSearchError(
      'BAD_RESPONSE',
      'DeepSeek Search returned a response without a results array.',
      response.status,
    )
  }

  const seen = new Set()
  const results = []
  for (const raw of rawResults) {
    const mapped = mapResult(raw)
    if (!mapped || !mapped.url) continue
    if (seen.has(mapped.url)) continue
    seen.add(mapped.url)
    results.push(mapped)
  }

  return { results, elapsedMs: Math.max(0, Date.now() - startedAt) }
}

/** Map one upstream snake_case result to the camelCase tool/route shape. */
export function mapResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    title: asString(raw.title),
    url: asString(raw.url),
    snippet: asString(raw.snippet),
    summary: asString(raw.summary),
    content: asString(raw.content),
    siteName: asNullableString(raw.site_name ?? raw.siteName),
    siteIcon: asNullableString(raw.site_icon ?? raw.siteIcon),
    date: asNullableString(raw.date),
    rerankScore: asFiniteNumber(raw.rerank_score ?? raw.rerankScore, 0),
    authority: asFiniteInteger(raw.authority, -1),
  }
}

/** Map an HTTP status plus upstream error body to `{ code, message }`. */
export function describeError(status, body) {
  const numericStatus = typeof status === 'number' && Number.isFinite(status) ? status : 0
  const code = codeForStatus(numericStatus)
  const upstream = extractUpstreamMessage(body)
  const detail = upstream || FALLBACK_MESSAGES[code] || 'the request failed'
  const prefix = numericStatus > 0
    ? `DeepSeek Search API returned HTTP ${numericStatus}`
    : 'DeepSeek Search request failed'
  return { code, message: `${prefix}: ${detail}` }
}

// --- internals -------------------------------------------------------------

function codeForStatus(status) {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 402) return 'INSUFFICIENT_BALANCE'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 408) return 'TIMEOUT'
  if (status === 413) return 'BAD_REQUEST'
  if (status === 429) return 'RATE_LIMITED'
  if (status >= 500 && status <= 599) return 'SERVER_ERROR'
  if (status >= 400 && status <= 499) return 'BAD_REQUEST'
  return 'BAD_RESPONSE'
}

function extractUpstreamMessage(body) {
  let value = body
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return ''
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        value = JSON.parse(text)
      } catch {
        return truncate(text, 240)
      }
    } else {
      return truncate(text, 240)
    }
  }
  if (!value || typeof value !== 'object') return ''
  const candidates = [
    value?.error?.message,
    value?.message,
    value?.error?.code,
    value?.detail,
    value?.msg,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return truncate(candidate.trim(), 240)
  }
  return ''
}

async function readResponseBody(response) {
  try {
    if (typeof response.text === 'function') return await response.text()
    if (typeof response.json === 'function') return await response.json()
  } catch {
    /* fall through to null */
  }
  return null
}

function combineSignals(signals) {
  const list = signals.filter((candidate) => candidate && typeof candidate.aborted === 'boolean')
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list)
  const controller = new AbortController()
  const abort = () => controller.abort()
  for (const candidate of list) {
    if (candidate.aborted) {
      abort()
      break
    }
    candidate.addEventListener('abort', abort, { once: true })
  }
  return controller.signal
}

function toTimeout(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(numeric, 120000)
}

function toFiniteInteger(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return Math.round(parsed)
  }
  return fallback
}

function asString(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function asNullableString(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function asFiniteNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asFiniteInteger(value, fallback) {
  const numeric = asFiniteNumber(value, fallback)
  return Number.isFinite(numeric) ? Math.round(numeric) : fallback
}

function messageOf(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message
  return String(error ?? 'unknown error')
}

/** Replace any accidental occurrence of the live key before a message escapes. */
function redact(message, apiKey) {
  const text = typeof message === 'string' ? message : String(message ?? '')
  if (!apiKey || apiKey.length < 8) return text
  return text.split(apiKey).join(maskKey(apiKey))
}

function truncate(text, max) {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}
