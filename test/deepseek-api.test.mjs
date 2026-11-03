import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DeepSeekSearchError,
  buildSearchRequest,
  clampCount,
  describeError,
  mapResult,
  maskKey,
  normalizeBaseUrl,
  searchDeepSeek,
} from '../deepseek-api.js'

// A deliberately fake key: no network is ever touched by this suite.
const FAKE_KEY = 'unit-test-key-not-a-real-credential'

function jsonResponse(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function baseOptions(overrides = {}) {
  return {
    apiKey: FAKE_KEY,
    baseUrl: 'https://api.deepseek.com',
    query: 'deepseek agent',
    ...overrides,
  }
}

function isErrorCode(code) {
  return (error) => error instanceof DeepSeekSearchError && error.code === code
}

test('clampCount keeps an integer inside 1..50', () => {
  assert.equal(clampCount(undefined), 10)
  assert.equal(clampCount(null), 10)
  assert.equal(clampCount(NaN), 10)
  assert.equal(clampCount('abc'), 10)
  assert.equal(clampCount(0), 1)
  assert.equal(clampCount(-5), 1)
  assert.equal(clampCount(1), 1)
  assert.equal(clampCount(20), 20)
  assert.equal(clampCount('20'), 20)
  assert.equal(clampCount(51), 50)
  assert.equal(clampCount(9999), 50)
  assert.equal(clampCount(7.6), 8)
  assert.equal(clampCount(undefined, 25), 25)
  assert.equal(clampCount(undefined, 999), 50)
})

test('normalizeBaseUrl drops trailing slashes and defaults sensibly', () => {
  assert.equal(normalizeBaseUrl(undefined), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl(''), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl('   '), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl(42), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl('https://api.deepseek.com///'), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl('  https://proxy.test/v1/  '), 'https://proxy.test/v1')
})

test('maskKey keeps the head and tail and never returns the raw key', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey(undefined), '')
  assert.equal(maskKey(null), '')
  assert.equal(maskKey('abc'), '…')
  assert.equal(maskKey('abcde'), 'ab…de')
  assert.equal(maskKey('abcdefghijklmnop'), 'abcdef…mnop')

  const masked = maskKey(FAKE_KEY)
  assert.ok(masked.includes('…'))
  assert.ok(masked.startsWith(FAKE_KEY.slice(0, 6)))
  assert.ok(masked.endsWith(FAKE_KEY.slice(-4)))
  assert.ok(masked.length < FAKE_KEY.length)
  assert.equal(masked.includes(FAKE_KEY), false)
})

test('buildSearchRequest produces the upstream snake_case body', () => {
  assert.deepEqual(buildSearchRequest({}), {
    query: '',
    count: 10,
    need_content: false,
  })

  assert.deepEqual(
    buildSearchRequest({
      query: '  deepseek agent  ',
      count: 3,
      needContent: true,
      oriQuestion: 'what is deepseek',
      localization: '1.2.3.4',
    }),
    {
      query: 'deepseek agent',
      count: 3,
      need_content: true,
      ori_question: 'what is deepseek',
      localization: '1.2.3.4',
    },
  )

  const clamped = buildSearchRequest({ query: 'x', count: 999 })
  assert.equal(clamped.count, 50)

  const noOptional = buildSearchRequest({ query: 'x', oriQuestion: '   ', localization: '' })
  assert.equal('ori_question' in noOptional, false)
  assert.equal('localization' in noOptional, false)
})

test('mapResult converts snake_case to camelCase and defaults missing fields', () => {
  assert.deepEqual(
    mapResult({
      rerank_score: 2.4,
      title: 'Title',
      url: 'https://example.test/a',
      snippet: 'Snippet',
      summary: 'Summary',
      content: 'Content',
      site_name: 'Example News',
      site_icon: 'https://example.test/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
    }),
    {
      title: 'Title',
      url: 'https://example.test/a',
      snippet: 'Snippet',
      summary: 'Summary',
      content: 'Content',
      siteName: 'Example News',
      siteIcon: 'https://example.test/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      rerankScore: 2.4,
      authority: 3,
    },
  )

  assert.deepEqual(mapResult({ url: 'https://example.test/min' }), {
    title: '',
    url: 'https://example.test/min',
    snippet: '',
    summary: '',
    content: '',
    siteName: null,
    siteIcon: null,
    date: null,
    rerankScore: 0,
    authority: -1,
  })

  assert.deepEqual(mapResult({ url: 'https://x.test', site_name: null, site_icon: null, date: null }), {
    ...mapResult({ url: 'https://x.test' }),
    siteName: null,
    siteIcon: null,
    date: null,
  })

  assert.equal(mapResult(null), null)
  assert.equal(mapResult(undefined), null)
  assert.equal(mapResult('nope'), null)
  assert.equal(mapResult([]), null)
  assert.equal(mapResult({}).url, '')
})

test('describeError maps HTTP statuses to stable codes with the status prefix', () => {
  const cases = [
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [402, 'INSUFFICIENT_BALANCE'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [408, 'TIMEOUT'],
    [413, 'BAD_REQUEST'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [504, 'SERVER_ERROR'],
  ]
  for (const [status, code] of cases) {
    const described = describeError(status, null)
    assert.equal(described.code, code, `status ${status}`)
    assert.match(described.message, new RegExp(`HTTP ${status}`))
    assert.equal(typeof described.message, 'string')
  }

  assert.equal(describeError(0, null).code, 'BAD_RESPONSE')

  const upstream = describeError(401, {
    error: { message: 'Invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_request_error' },
  })
  assert.equal(upstream.code, 'UNAUTHORIZED')
  assert.match(upstream.message, /HTTP 401/)
  assert.match(upstream.message, /Invalid API key/)

  const stringBody = describeError(400, 'plain upstream failure')
  assert.equal(stringBody.code, 'BAD_REQUEST')
  assert.match(stringBody.message, /plain upstream failure/)
})

test('searchDeepSeek posts the expected request and maps results', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      results: [
        {
          rerank_score: 2.1,
          title: 'A',
          url: 'https://a.test/1',
          snippet: 'sa',
          summary: 'ma',
          content: '',
          site_name: 'A News',
          site_icon: null,
          date: null,
          authority: 4,
        },
        {
          rerank_score: 1.1,
          title: 'B',
          url: 'https://b.test/2',
          snippet: 'sb',
          summary: '',
          content: '',
          site_name: null,
          site_icon: null,
          date: '2026-01-01',
          authority: 1,
        },
      ],
    })
  }

  const { results, elapsedMs } = await searchDeepSeek(
    baseOptions({ fetchImpl, count: 2, needContent: false, oriQuestion: 'q', localization: '1.2.3.4' }),
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(calls[0].init.method, 'POST')
  assert.match(calls[0].init.headers.authorization, /^Bearer /)
  assert.ok(calls[0].init.headers.authorization.endsWith(FAKE_KEY))
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.ok(calls[0].init.signal && typeof calls[0].init.signal.aborted === 'boolean')

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: 'deepseek agent',
    count: 2,
    need_content: false,
    ori_question: 'q',
    localization: '1.2.3.4',
  })

  assert.equal(results.length, 2)
  assert.equal(results[0].title, 'A')
  assert.equal(results[0].siteName, 'A News')
  assert.equal(results[0].rerankScore, 2.1)
  assert.equal(results[0].authority, 4)
  assert.equal(results[1].siteName, null)
  assert.equal(results[1].date, '2026-01-01')
  assert.ok(typeof elapsedMs === 'number')
  assert.ok(elapsedMs >= 0)
})

test('searchDeepSeek normalises the base URL and trims the query', async () => {
  let seenUrl = ''
  let seenBody = null
  const fetchImpl = async (url, init) => {
    seenUrl = url
    seenBody = JSON.parse(init.body)
    return jsonResponse({ results: [] })
  }

  const { results } = await searchDeepSeek(
    baseOptions({ fetchImpl, baseUrl: 'https://proxy.test/  ', query: '  padded query  ' }),
  )

  assert.equal(seenUrl, 'https://proxy.test/v1/tools/search')
  assert.equal(seenBody.query, 'padded query')
  assert.deepEqual(results, [])
})

test('searchDeepSeek returns an empty result list without raising', async () => {
  const fetchImpl = async () => jsonResponse({ results: [] })
  const { results, elapsedMs } = await searchDeepSeek(baseOptions({ fetchImpl }))
  assert.deepEqual(results, [])
  assert.ok(typeof elapsedMs === 'number')
})

test('searchDeepSeek de-duplicates by url and drops entries without a url', async () => {
  const fetchImpl = async () =>
    jsonResponse({
      results: [
        { title: 'first', url: 'https://a.test/x' },
        { title: 'duplicate', url: 'https://a.test/x' },
        { title: 'no url' },
        {},
        null,
      ],
    })

  const { results } = await searchDeepSeek(baseOptions({ fetchImpl }))
  assert.equal(results.length, 1)
  assert.equal(results[0].title, 'first')
})

test('searchDeepSeek rejects a missing key before any network call', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return jsonResponse({ results: [] })
  }

  await assert.rejects(searchDeepSeek(baseOptions({ apiKey: '', fetchImpl })), isErrorCode('MISSING_API_KEY'))
  await assert.rejects(searchDeepSeek(baseOptions({ apiKey: '   ', fetchImpl })), isErrorCode('MISSING_API_KEY'))
  assert.equal(called, false)
})

test('searchDeepSeek validates the query', async () => {
  const fetchImpl = async () => jsonResponse({ results: [] })

  await assert.rejects(searchDeepSeek(baseOptions({ query: '', fetchImpl })), isErrorCode('BAD_REQUEST'))
  await assert.rejects(searchDeepSeek(baseOptions({ query: '    ', fetchImpl })), isErrorCode('BAD_REQUEST'))
  await assert.rejects(searchDeepSeek(baseOptions({ query: undefined, fetchImpl })), isErrorCode('BAD_REQUEST'))
  await assert.rejects(
    searchDeepSeek(baseOptions({ query: 'x'.repeat(129), fetchImpl })),
    isErrorCode('BAD_REQUEST'),
  )
})

test('searchDeepSeek maps upstream HTTP failures and never leaks the key', async () => {
  const cases = [
    [401, { error: { message: 'Invalid API key' } }, 'UNAUTHORIZED'],
    [402, { error: { message: 'Insufficient balance' } }, 'INSUFFICIENT_BALANCE'],
    [403, { error: { message: 'Blocked' } }, 'FORBIDDEN'],
    [404, { error: { message: 'Unavailable' } }, 'NOT_FOUND'],
    [408, { error: { message: 'Timeout' } }, 'TIMEOUT'],
    [413, { error: { message: 'Too large' } }, 'BAD_REQUEST'],
    [429, { error: { message: 'QPS limited' } }, 'RATE_LIMITED'],
    [500, { error: { message: 'Upstream blew up' } }, 'SERVER_ERROR'],
    [504, { error: { message: 'Gateway timeout' } }, 'SERVER_ERROR'],
  ]

  for (const [status, body, code] of cases) {
    const fetchImpl = async () => jsonResponse(body, status)
    await assert.rejects(searchDeepSeek(baseOptions({ fetchImpl })), (error) => {
      assert.ok(error instanceof DeepSeekSearchError)
      assert.equal(error.code, code, `status ${status}`)
      assert.equal(error.status, status)
      assert.match(error.message, new RegExp(`HTTP ${status}`))
      assert.match(error.message, new RegExp(body.error.message))
      assert.equal(error.message.includes(FAKE_KEY), false)
      assert.equal(error.message.includes(FAKE_KEY.slice(0, 12)), false)
      return true
    })
  }
})

test('searchDeepSeek reports network failures as NETWORK_ERROR', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(searchDeepSeek(baseOptions({ fetchImpl })), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.match(error.message, /fetch failed/)
    assert.equal(error.message.includes(FAKE_KEY), false)
    return true
  })
})

test('searchDeepSeek reports a timeout as TIMEOUT', async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted by timeout signal')), { once: true })
    })

  await assert.rejects(searchDeepSeek(baseOptions({ fetchImpl, timeoutMs: 10 })), isErrorCode('TIMEOUT'))
})

test('searchDeepSeek reports a caller abort as NETWORK_ERROR', async () => {
  const controller = new AbortController()
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })

  const pending = searchDeepSeek(
    baseOptions({ fetchImpl, signal: controller.signal, timeoutMs: 5000 }),
  )
  controller.abort()

  await assert.rejects(pending, isErrorCode('NETWORK_ERROR'))
})

test('searchDeepSeek rejects malformed upstream payloads as BAD_RESPONSE', async () => {
  const notJson = async () => jsonResponse('this is not json', 200)
  await assert.rejects(searchDeepSeek(baseOptions({ fetchImpl: notJson })), isErrorCode('BAD_RESPONSE'))

  const noResults = async () => jsonResponse({ data: [] }, 200)
  await assert.rejects(searchDeepSeek(baseOptions({ fetchImpl: noResults })), isErrorCode('BAD_RESPONSE'))

  const badResults = async () => jsonResponse({ results: 'nope' }, 200)
  await assert.rejects(searchDeepSeek(baseOptions({ fetchImpl: badResults })), isErrorCode('BAD_RESPONSE'))

  const noResponse = async () => undefined
  await assert.rejects(searchDeepSeek(baseOptions({ fetchImpl: noResponse })), isErrorCode('BAD_RESPONSE'))
})

test('DeepSeekSearchError keeps its code, status and name', () => {
  const error = new DeepSeekSearchError('BAD_REQUEST', 'nope', 400)
  assert.equal(error.name, 'DeepSeekSearchError')
  assert.equal(error.code, 'BAD_REQUEST')
  assert.equal(error.status, 400)
  assert.equal(error.message, 'nope')
  assert.ok(error instanceof Error)
})
