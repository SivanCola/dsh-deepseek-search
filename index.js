/**
 * Host half of @local/dsh-deepseek-search.
 *
 * Registers the model-facing `deepseek_search` tool for every agent/model and
 * the three POST routes the browser panel talks to:
 *
 *   POST /api/dsh-deepseek-search/status
 *   POST /api/dsh-deepseek-search/search
 *   POST /api/dsh-deepseek-search/key
 *
 * The API key is an independent DeepSeek key resolved per call (inline config →
 * credential store → process.env) and is never cached, logged or echoed.
 */

import {
  DeepSeekSearchError,
  clampCount,
  maskKey,
  normalizeBaseUrl,
  searchDeepSeek,
} from './deepseek-api.js'

export const inject = ['tools', 'connection', 'credentials']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_SEARCH_API_KEY'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_COUNT = 10
const DEFAULT_NEED_CONTENT = false
const DEFAULT_TIMEOUT_MS = 25000
const DEFAULT_TOOL_NAME = 'deepseek_search'
const ROUTE_PREFIX = '/api/dsh-deepseek-search'
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

const TOOL_DESCRIPTION = [
  'Search the live web with the standalone DeepSeek Search API.',
  'This tool uses its own DeepSeek Search API key configured in the DeepSeek Search panel (left sidebar),',
  'independently of the model provider — any model/agent can use it.',
  'Returns ranked results with title, url, snippet, summary, optional full page content, site name,',
  'publish date, rerank score and an authority rank (-1 unknown, 0-4 higher is more authoritative).',
  'The query is passed through untouched and supports the DeepSeek Search operators:',
  'site:<domain> to restrict to a domain, -site:<domain> to exclude one, -word or -"phrase" to exclude terms,',
  '"exact phrase" for exact matching, lang:zh,en to prefer languages, after:2025-01-01 and before:2026 to bound publish dates.',
  'Keep the query at 128 characters or fewer. Set need_content only when full page text is required,',
  'because it is slower and returns much larger payloads.',
].join(' ')

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      description:
        'The search query, 1-128 characters. Supports site:, -site:, -word, "exact phrase", lang:zh,en, after: and before:.',
    },
    count: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Number of results to return (1-50). Defaults to 10.',
    },
    need_content: {
      type: 'boolean',
      description: 'When true, also return the full page text in content (slower and larger). Defaults to false.',
    },
    ori_question: {
      type: 'string',
      description: "The user's original question, which improves intent matching.",
    },
  },
}

// The tool-schema projection only accepts a single `type` string per node, so a
// nullable field is expressed as oneOf(string, null) rather than a type array.
function nullableString(description) {
  return { oneOf: [{ type: 'string' }, { type: 'null' }], description }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    count: { type: 'integer' },
    elapsedMs: { type: 'number' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          snippet: { type: 'string' },
          summary: { type: 'string' },
          content: { type: 'string' },
          siteName: nullableString('Site name, or null when unknown.'),
          siteIcon: nullableString('Site icon URL, or null when unknown.'),
          date: nullableString('Publish date as a UTC RFC 3339 timestamp, or null when unknown.'),
          rerankScore: { type: 'number' },
          authority: { type: 'integer' },
        },
      },
    },
  },
}

export function apply(ctx, config) {
  const options = readOptions(config)

  ctx.effect(
    () => ctx.tools.register(buildToolDefinition(ctx, options)),
    'deepseek-search: tool',
  )

  ctx.effect(
    () => ctx.connection.fetch.register(buildStatusRoute(ctx, options)),
    'deepseek-search: status route',
  )
  ctx.effect(
    () => ctx.connection.fetch.register(buildSearchRoute(ctx, options)),
    'deepseek-search: search route',
  )
  ctx.effect(
    () => ctx.connection.fetch.register(buildKeyRoute(ctx, options)),
    'deepseek-search: key route',
  )
}

// --- config -----------------------------------------------------------------

function readOptions(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    apiKeyEnv:
      typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? raw.apiKeyEnv.trim() : DEFAULT_API_KEY_ENV,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    count: clampCount(raw.count, DEFAULT_COUNT),
    needContent: raw.needContent === true,
    timeoutMs:
      Number.isFinite(Number(raw.timeoutMs)) && Number(raw.timeoutMs) > 0
        ? Number(raw.timeoutMs)
        : DEFAULT_TIMEOUT_MS,
    toolName:
      typeof raw.toolName === 'string' && raw.toolName.trim() ? raw.toolName.trim() : DEFAULT_TOOL_NAME,
  }
}

// --- key resolution ---------------------------------------------------------

/** Resolve the key for this call only: config → credential store → env. */
async function resolveApiKey(ctx, options) {
  if (options.apiKey) return { apiKey: options.apiKey, source: 'config' }
  try {
    const resolved = await ctx.credentials.resolve(options.apiKeyEnv)
    const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    if (value) return { apiKey: value, source: 'credentials' }
  } catch {
    /* missing or unavailable credential store: fall through to env */
  }
  const fromEnv = readEnv(options.apiKeyEnv)
  if (fromEnv) return { apiKey: fromEnv, source: 'env' }
  return null
}

function readEnv(name) {
  try {
    const env = typeof process !== 'undefined' ? process.env : undefined
    if (!env) return ''
    const value = env[name]
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}

function missingKeyMessage(apiKeyEnv) {
  return `DeepSeek Search API key is not configured. Set it in the DeepSeek Search panel (left sidebar) — it is stored as ${apiKeyEnv}.`
}

async function buildStatus(ctx, options) {
  const resolved = await resolveApiKey(ctx, options)
  let source = resolved ? resolved.source : null
  if (!resolved) {
    try {
      const described = await ctx.credentials.describe(options.apiKeyEnv)
      if (described && typeof described.source === 'string') source = described.source
    } catch {
      /* keep null */
    }
  }
  return {
    configured: Boolean(resolved),
    source,
    maskedKey: resolved ? maskKey(resolved.apiKey) : '',
    apiKeyEnv: options.apiKeyEnv,
    baseUrl: options.baseUrl,
    toolName: options.toolName,
    defaults: { count: options.count, needContent: options.needContent },
  }
}

// --- tool -------------------------------------------------------------------

function buildToolDefinition(ctx, options) {
  return {
    name: options.toolName,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: renderSearchText(args, value) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: options.timeoutMs + 5000,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const query = typeof input.query === 'string' ? input.query.trim() : ''
      if (!query) throw new Error('DeepSeek Search query is required and must be a non-empty string.')
      const resolved = await resolveApiKey(ctx, options)
      if (!resolved) throw new Error(missingKeyMessage(options.apiKeyEnv))
      try {
        const { results, elapsedMs } = await searchDeepSeek({
          apiKey: resolved.apiKey,
          baseUrl: options.baseUrl,
          query,
          count: clampCount(input.count, options.count),
          needContent: typeof input.need_content === 'boolean' ? input.need_content : options.needContent,
          oriQuestion: typeof input.ori_question === 'string' ? input.ori_question : '',
          timeoutMs: options.timeoutMs,
          signal: exec?.signal,
        })
        return {
          query,
          count: clampCount(input.count, options.count),
          elapsedMs,
          results,
        }
      } catch (error) {
        throw new Error(toolErrorMessage(error, options))
      }
    },
  }
}

function toolErrorMessage(error, options) {
  if (error instanceof DeepSeekSearchError) {
    if (error.code === 'MISSING_API_KEY') return missingKeyMessage(options.apiKeyEnv)
    if (error.code === 'UNAUTHORIZED') {
      return `${error.message} Update the key in the DeepSeek Search panel (left sidebar) — it is stored as ${options.apiKeyEnv}.`
    }
    if (error.code === 'INSUFFICIENT_BALANCE') {
      return `${error.message} Top up the DeepSeek account or switch the key in the DeepSeek Search panel.`
    }
    if (error.code === 'RATE_LIMITED') {
      return `${error.message} Wait a moment and try again with a smaller count.`
    }
    return error.message
  }
  return error && typeof error.message === 'string' && error.message
    ? `DeepSeek Search failed: ${error.message}`
    : 'DeepSeek Search failed unexpectedly.'
}

function renderSearchText(args, value) {
  const query =
    value && typeof value.query === 'string'
      ? value.query
      : args && typeof args.query === 'string'
        ? args.query.trim()
        : ''
  const results = value && Array.isArray(value.results) ? value.results : []
  const elapsedMs =
    value && Number.isFinite(value.elapsedMs) ? Math.max(0, Math.round(value.elapsedMs)) : 0

  if (results.length === 0) {
    return `DeepSeek Search 未找到与 "${truncateText(query, 128)}" 匹配的结果。`
  }

  const wantsContent = Boolean(args && args.need_content === true)
  const lines = [`DeepSeek Search · "${truncateText(query, 128)}" · ${results.length} 条结果 · ${elapsedMs}ms`]

  results.forEach((result, index) => {
    const title = truncateText(oneLine(result?.title), 140) || '(untitled)'
    const url = truncateText(oneLine(result?.url), 220)
    const body = oneLine(result?.summary) || oneLine(result?.snippet)
    const entry = [`${index + 1}. ${title}`, `   ${url}`]
    if (body) entry.push(`   ${truncateText(body, 320)}`)
    if (wantsContent) {
      const content = oneLine(result?.content)
      if (content) entry.push(`   content: ${truncateText(content, 260)}`)
    }
    lines.push(entry.join('\n'))
  })

  return lines.join('\n')
}

// --- HTTP routes ------------------------------------------------------------

function buildStatusRoute(ctx, options) {
  return {
    path: `${ROUTE_PREFIX}/status`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guarded(async () => okJson(await buildStatus(ctx, options))),
  }
}

function buildSearchRoute(ctx, options) {
  return {
    path: `${ROUTE_PREFIX}/search`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guarded(async (request) => {
      const body = await readJsonBody(request)
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      if (!query) return errorJson('BAD_REQUEST', 'query is required.', 400)

      const resolved = await resolveApiKey(ctx, options)
      if (!resolved) return errorJson('MISSING_API_KEY', missingKeyMessage(options.apiKeyEnv), 401)

      const count = clampCount(body.count, options.count)
      const needContent =
        typeof body.needContent === 'boolean' ? body.needContent : options.needContent
      const oriQuestion = typeof body.oriQuestion === 'string' ? body.oriQuestion : ''
      const localization = typeof body.localization === 'string' ? body.localization : ''

      try {
        const { results, elapsedMs } = await searchDeepSeek({
          apiKey: resolved.apiKey,
          baseUrl: options.baseUrl,
          query,
          count,
          needContent,
          oriQuestion,
          localization,
          timeoutMs: options.timeoutMs,
          signal: request?.signal,
        })
        return okJson({ query, count, elapsedMs, results })
      } catch (error) {
        return routeError(error)
      }
    }),
  }
}

function buildKeyRoute(ctx, options) {
  return {
    path: `${ROUTE_PREFIX}/key`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: guarded(async (request) => {
      const body = await readJsonBody(request)
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      try {
        if (apiKey) await ctx.credentials.set(options.apiKeyEnv, apiKey)
        else await ctx.credentials.unset(options.apiKeyEnv)
      } catch {
        return errorJson('INTERNAL', 'Could not update the stored DeepSeek Search API key.', 500)
      }
      return okJson(await buildStatus(ctx, options))
    }),
  }
}

async function readJsonBody(request) {
  try {
    const body = await request?.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    return {}
  }
}

function routeError(error) {
  if (error instanceof DeepSeekSearchError) {
    return errorJson(error.code, error.message, httpStatusForCode(error.code))
  }
  const message =
    error && typeof error.message === 'string' && error.message
      ? error.message
      : 'DeepSeek Search failed unexpectedly.'
  return errorJson('INTERNAL', truncateText(oneLine(message), 300), 500)
}

function httpStatusForCode(code) {
  switch (code) {
    case 'MISSING_API_KEY':
    case 'UNAUTHORIZED':
      return 401
    case 'INSUFFICIENT_BALANCE':
      return 402
    case 'FORBIDDEN':
      return 403
    case 'NOT_FOUND':
      return 404
    case 'TIMEOUT':
      return 408
    case 'RATE_LIMITED':
      return 429
    case 'BAD_REQUEST':
      return 400
    case 'NETWORK_ERROR':
    case 'BAD_RESPONSE':
    case 'SERVER_ERROR':
      return 502
    default:
      return 500
  }
}

function guarded(handler) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      const message =
        error && typeof error.message === 'string' && error.message
          ? truncateText(oneLine(error.message), 300)
          : 'DeepSeek Search route failed.'
      return errorJson('INTERNAL', message, 500)
    }
  }
}

function okJson(value) {
  return new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: JSON_HEADERS })
}

function errorJson(code, message, status) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: JSON_HEADERS,
  })
}

// --- text helpers -----------------------------------------------------------

function oneLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

function truncateText(value, max) {
  const text = typeof value === 'string' ? value : ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}
