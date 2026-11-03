import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FALLBACK_OFFICIAL_REFS,
  KNOWN_DEEPSEEK_NAMESPACES,
  collectOfficialKeyRefs,
  describeSource,
  officialNamespaces,
} from '../official-key.js'

test('officialNamespaces keeps first-party provider namespaces in order', () => {
  const providers = [
    { provider: 'deepseek-official', settingsNs: 'llm-deepseek' },
    { provider: 'something-else', settingsNs: 'llm-pi-ai' },
    { provider: 'deepseek-official', settingsNs: 'extra-deepseek' },
    { provider: 'deepseek-official', settingsNs: 'llm-deepseek' },
    { provider: 'deepseek-official' },
    null,
    'nope',
  ]
  assert.deepEqual(officialNamespaces(providers), ['llm-deepseek', 'extra-deepseek'])
})

test('officialNamespaces tolerates a missing directory', () => {
  assert.deepEqual(officialNamespaces(undefined), [])
  assert.deepEqual(officialNamespaces(null), [])
  assert.deepEqual(officialNamespaces('oops'), [])
})

test('collectOfficialKeyRefs orders provider namespaces, known namespaces, then the default ref', () => {
  const refs = collectOfficialKeyRefs({
    providers: [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek' }],
    descriptors: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'TEAM_DEEPSEEK_KEY' } },
      { ns: 'web-deepseek-api', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
    ],
  })
  assert.deepEqual(refs, ['TEAM_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY'])
})

test('collectOfficialKeyRefs falls back to the known namespace list without a provider directory', () => {
  const refs = collectOfficialKeyRefs({
    descriptors: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'AZURE_STYLE_REF' } },
      { ns: 'llm-pi-ai', value: { apiKeyEnv: 'MAGPIE_GATEWAY_KEY' } },
    ],
  })
  assert.equal(refs[0], 'AZURE_STYLE_REF')
  // The unrelated proxy namespace is never consulted.
  assert.equal(refs.includes('MAGPIE_GATEWAY_KEY'), false)
  assert.ok(refs.includes('DEEPSEEK_API_KEY'))
})

test('collectOfficialKeyRefs always ends with the shipped default ref', () => {
  const refs = collectOfficialKeyRefs({})
  assert.deepEqual(refs, [...FALLBACK_OFFICIAL_REFS])
})

test('collectOfficialKeyRefs never reports the plugin own ref as official', () => {
  const refs = collectOfficialKeyRefs({
    descriptors: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_SEARCH_API_KEY' } }],
    excludeRef: 'DEEPSEEK_SEARCH_API_KEY',
  })
  assert.equal(refs.includes('DEEPSEEK_SEARCH_API_KEY'), false)
  assert.deepEqual(refs, [...FALLBACK_OFFICIAL_REFS])
})

test('collectOfficialKeyRefs de-duplicates and skips malformed descriptors', () => {
  const refs = collectOfficialKeyRefs({
    providers: [{ provider: 'deepseek-official', settingsNs: 'llm-deepseek' }],
    descriptors: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'IGNORED_SECOND' } },
      { ns: 'web-search-deepseek', value: { apiKeyEnv: 'OTHER_REF' } },
      { ns: 'web-search-deepseek', value: null },
      { value: { apiKeyEnv: 'NO_NAMESPACE' } },
      null,
    ],
  })
  assert.deepEqual(refs, ['DEEPSEEK_API_KEY', 'OTHER_REF'])
})

test('collectOfficialKeyRefs ignores blank and non-string apiKeyEnv values', () => {
  const refs = collectOfficialKeyRefs({
    descriptors: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: '   ' } },
      { ns: 'web-deepseek-api', value: { apiKeyEnv: 42 } },
    ],
  })
  assert.deepEqual(refs, [...FALLBACK_OFFICIAL_REFS])
})

test('the known namespace list is stable', () => {
  assert.deepEqual(KNOWN_DEEPSEEK_NAMESPACES, [
    'llm-deepseek',
    'web-deepseek-api',
    'web-search-deepseek',
  ])
})

test('describeSource maps each resolution kind', () => {
  assert.deepEqual(describeSource('config'), { kind: 'config', ref: null })
  assert.deepEqual(describeSource('credentials', 'DEEPSEEK_SEARCH_API_KEY'), {
    kind: 'own',
    ref: 'DEEPSEEK_SEARCH_API_KEY',
  })
  assert.deepEqual(describeSource('official', 'DEEPSEEK_API_KEY'), {
    kind: 'official',
    ref: 'DEEPSEEK_API_KEY',
  })
  assert.deepEqual(describeSource('env', 'DEEPSEEK_API_KEY'), {
    kind: 'env',
    ref: 'DEEPSEEK_API_KEY',
  })
  assert.deepEqual(describeSource(undefined), { kind: null, ref: null })
})
