/**
 * Discovery of the "official" DeepSeek API key that the Harness already holds.
 *
 * The plugin's own credential (`DEEPSEEK_SEARCH_API_KEY`) always wins. This module
 * only answers: *which* credential refs the Harness' own DeepSeek configuration
 * points at, in priority order, so the caller can try them as a fallback.
 *
 * Pure and Cordis-free: every input is plain data, so the ordering rules are
 * unit-testable (see test/official-key.test.mjs).
 */

/** Provider ids the Harness uses for a first-party DeepSeek endpoint. */
const OFFICIAL_PROVIDER_IDS = ['deepseek-official']

/**
 * Settings namespaces known to carry a DeepSeek `apiKeyEnv`, used both as a
 * fallback when the provider directory is unavailable and as a supplement to it.
 */
export const KNOWN_DEEPSEEK_NAMESPACES = [
  'llm-deepseek',
  'web-deepseek-api',
  'web-search-deepseek',
]

/** Refs tried last, when no namespace points at one (the shipped default name). */
export const FALLBACK_OFFICIAL_REFS = ['DEEPSEEK_API_KEY']

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function pushUnique(list, value) {
  const text = cleanString(value)
  if (!text) return
  if (!list.includes(text)) list.push(text)
}

/** Settings namespaces of the first-party DeepSeek providers in a provider directory. */
export function officialNamespaces(providers) {
  const list = []
  if (!Array.isArray(providers)) return list
  for (const entry of providers) {
    const record = asRecord(entry)
    if (!record) continue
    if (!OFFICIAL_PROVIDER_IDS.includes(cleanString(record.provider))) continue
    pushUnique(list, record.settingsNs)
  }
  return list
}

/**
 * Build the ordered list of credential refs to try for an official DeepSeek key.
 *
 * Order: the live provider directory's DeepSeek namespaces first, then the known
 * namespace list, then the shipped default ref name. `excludeRef` drops the
 * plugin's own ref so it is never reported as an "official" source.
 */
export function collectOfficialKeyRefs({ providers, descriptors, excludeRef } = {}) {
  const refs = []
  const excluded = cleanString(excludeRef)
  const namespaces = officialNamespaces(providers)
  for (const ns of KNOWN_DEEPSEEK_NAMESPACES) pushUnique(namespaces, ns)

  const byNamespace = new Map()
  if (Array.isArray(descriptors)) {
    for (const descriptor of descriptors) {
      const record = asRecord(descriptor)
      if (!record) continue
      const ns = cleanString(record.ns)
      if (!ns || byNamespace.has(ns)) continue
      byNamespace.set(ns, asRecord(record.value) ?? null)
    }
  }

  for (const ns of namespaces) {
    const value = byNamespace.get(ns)
    if (!value) continue
    pushUnique(refs, value.apiKeyEnv)
  }
  for (const ref of FALLBACK_OFFICIAL_REFS) pushUnique(refs, ref)

  return refs.filter((ref) => ref !== excluded)
}

/**
 * Short human/machine label for where a resolved key came from.
 * `ref` is the credential ref that actually produced the value.
 */
export function describeSource(source, ref) {
  switch (source) {
    case 'config':
      return { kind: 'config', ref: null }
    case 'credentials':
      return { kind: 'own', ref: cleanString(ref) || null }
    case 'official':
      return { kind: 'official', ref: cleanString(ref) || null }
    case 'env':
      return { kind: 'env', ref: cleanString(ref) || null }
    default:
      return { kind: null, ref: null }
  }
}
