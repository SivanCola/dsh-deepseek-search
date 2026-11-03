# SPEC — `@local/dsh-deepseek-search`

A DeepSeek Harness bundle. Two halves:

- **Host half** (`index.js`) — registers the model-facing tool `deepseek_search` for **every** agent/model
  and three HTTP endpoints for the browser panel. Talks to `https://api.deepseek.com/v1/tools/search`.
- **Client half** (`client.js`) — a left-sidebar entry (`sidebar.panellist`) that opens a full search page
  in the main column (`main`, key `deepseek-search`).

Everything below was verified against the live installed Harness via `cordis_inspect_query`.
Do not invent APIs — use exactly what is written here.

---

## 1. DeepSeek Search API (upstream, server-side only)

```
POST https://api.deepseek.com/v1/tools/search
Authorization: Bearer <DeepSeek API key>
Content-Type: application/json
```

Request body:

| field | type | required | notes |
|---|---|---|---|
| `query` | string | yes | 1–128 unicode chars, not all whitespace |
| `count` | integer | no | 1–50, default 10 |
| `ori_question` | string | no | 1–128 chars, the user's original question |
| `localization` | string | no | IP address used to prefer localized results, default `""` |
| `need_content` | boolean | no | default false; when false `content` is always `""` |

Success `200`:

```json
{ "results": [ {
  "rerank_score": 2.4, "title": "…", "url": "https://…",
  "snippet": "…", "summary": "…", "content": "…",
  "site_name": "Example News", "site_icon": "https://…/favicon.ico",
  "date": "2026-06-01T00:00:00+00:00", "authority": 3
} ] }
```

`site_name`, `site_icon`, `date` may be `null`. `authority` is `-1..4` (-1 unknown). Empty array = no matches.

Error body (non-2xx):

```json
{ "error": { "message": "'count' must be between 1 and 50", "type": "invalid_request_error", "param": null, "code": "invalid_request_error" } }
```

Status codes: `400` bad request, `401` bad/missing key, `402` insufficient balance, `403` blocked,
`404` unavailable, `408` timeout, `413` too large, `429` QPS limited, `500`/`504` upstream.

Search syntax supported inside `query` (pass through untouched): `site:`, `-site:`, `-word`, `-"phrase"`,
`"exact phrase"`, `lang:zh,en`, `after:2025-01-01`, `before:2026`.

---

## 2. File layout (all under `/Users/work/Desktop/code/dsh-deepseek-search/`)

```
package.json              bundle manifest + dsh.bundle / dsh.client sections
cordis.patch.yml          the bundle patch row (id: dsh-deepseek-search)
locale/en.json            meta.title / meta.description for Plugin Manager
locale/zh.json
icon.svg
LICENSE  .gitignore       MIT; ignores node_modules/, .DS_Store, *.log
index.js                  Host half: tool + 3 Fetch routes + key resolution
deepseek-api.js           pure DeepSeek HTTP client, no Cordis imports
official-key.js           pure discovery of the official DeepSeek credential refs
client.js                 Client half: sidebar.panellist + main panel
test/deepseek-api.test.mjs  18 cases
test/official-key.test.mjs  10 cases
README.md
SPEC.md                   this contract
```

`index.js` imports `./deepseek-api.js` and `./official-key.js` with ESM `import`.
All files are ESM (`"type": "module"` in package.json). Plain JavaScript, no TypeScript, no build step,
no npm dependencies. Node 22+ / browsers with `fetch`, `AbortSignal.timeout`.

`export` names in `index.js`: `apply`, `inject`. **Do not** export `Config` (no schemastery dependency
available to a workspace-linked bundle).

---

## 3. Host half — `index.js`

```js
export const inject = ['tools', 'connection', 'credentials']
export function apply(ctx, config) { /* ... */ }
```

`config` is a plain object (unvalidated). Read defensively with defaults:

| key | default | meaning |
|---|---|---|
| `apiKey` | `''` | inline key; highest priority, overrides the credential store |
| `apiKeyEnv` | `'DEEPSEEK_SEARCH_API_KEY'` | credential ref name resolved through `ctx.credentials` |
| `useOfficialKey` | `true` | when no standalone key resolves, reuse the official DeepSeek key the Harness already holds for the model provider |
| `baseUrl` | `'https://api.deepseek.com'` | origin, no trailing slash |
| `count` | `10` | default result count, clamp 1..50 |
| `needContent` | `false` | default for `need_content` |
| `timeoutMs` | `25000` | per-request timeout |
| `toolName` | `'deepseek_search'` | registered tool name |

### 3.1 Host service contracts (verbatim)

**`ctx.tools`** — `register(definition: ToolDefinition): () => void`

```ts
interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }
interface ToolOutputDefinition { readonly schema: JsonSchemaNode; render(args: unknown, value: JsonValue): ContentBlock[]; presentationMeta?(args: unknown, value: JsonValue): JsonValue }
interface ToolDefinition extends ToolSchema {
  readonly output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

`ToolRunContext` extends `ToolExecution` and carries `readonly signal: AbortSignal` — forward it into
`fetch`. `ContentBlock` for text is `{ type: 'text', text: string }`.
A thrown `Error` inside `execute` is materialized by the framework as an error tool result — use that
for failures so the model sees a clean message.

**`ctx.connection`** — exact Fetch routes, browser-facing:

```ts
ctx.connection.fetch.register(route: {
  readonly path: string                        // e.g. '/api/dsh-deepseek-search/search'  (WITH leading slash)
  readonly methods: readonly ('GET'|'HEAD'|'POST')[]
  readonly requestBody: 'buffered' | 'streaming'
  readonly fetch: (request: Request) => Promise<Response>
}): () => Promise<void>
```

The browser reaches it as `api/dsh-deepseek-search/search` (relative URL, no leading slash).
Only GET/HEAD/POST are allowed — use POST everywhere, including "clear the key".

**`ctx.credentials`**

```ts
resolve(ref: string): Promise<{ value: string; source: string } | undefined>
describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
set(ref: string, value: string): Promise<void>       // empty value rejected — use unset to clear
unset(ref: string): Promise<void>
```

A `CredentialRef` is just the environment-variable name string. Resolution is **per call**:
never cache the key across operations. Never log or return the raw key.

### 3.2 Key resolution (host)

The plugin's own credential always wins; the official key is a fallback so a model whose provider has no
search capability can search with a key the user already configured for the model list.

```
resolveApiKey():
  1. config.apiKey trimmed, if non-empty             -> { apiKey, source: 'config',      ref: null }
  2. ctx.credentials.resolve(config.apiKeyEnv)        -> { apiKey, source: 'credentials', ref: apiKeyEnv }
  3. officialRefs() in order (when useOfficialKey)    -> { apiKey, source: 'official',    ref }
     ctx.credentials.resolve(ref) for the first ref with a non-empty value
  4. process.env[config.apiKeyEnv], then process.env
     for each of FALLBACK_OFFICIAL_REFS (DEEPSEEK_API_KEY) -> { apiKey, source: 'env', ref }
  else null
```

`officialRefs()` (see `official-key.js`) builds the candidate refs, ordered:

1. settings namespaces of providers whose `provider === 'deepseek-official'`
   (`ctx.llm.listConfigurableProviders()` → `settingsNs`);
2. the known namespace list `llm-deepseek`, `web-deepseek-api`, `web-search-deepseek`;
3. the shipped default ref name `DEEPSEEK_API_KEY`.

For each namespace it reads `value.apiKeyEnv` from `ctx.settings.describe({ redactSecrets: true })`.
The plugin's own ref is excluded so it is never reported as an "official" source.

The official provider's `baseURL` is **not** adopted: it is frequently a local or corporate proxy that does
not implement `/v1/tools/search`. Interface address changes belong in `baseUrl`.

`maskKey(key)` → `sk-abc…8f2c` style (keep first 6 and last 4, mask the middle). The raw key never crosses
HTTP, and only the credential **ref name** (e.g. `DEEPSEEK_API_KEY`) is ever reported.

A rejected key must name the ref that actually produced the request — see `keyOriginHint()`; otherwise a
failure on the official key would send the user to a panel field they never filled.

### 3.3 Registered tool

```
name:        config.toolName                      // default 'deepseek_search'
description: English, model-facing, states it uses the standalone DeepSeek Search API
             (independent of the model provider), and summarises the query syntax
             (site:, -site:, -word, "phrase", lang:, after:, before:).
parameters:  { type:'object', additionalProperties:false, required:['query'], properties:{
               query:{type:'string', description:'…1–128 characters, supports site:, after:, lang: …'},
               count:{type:'integer', minimum:1, maximum:50, description:'…default 10'},
               need_content:{type:'boolean', description:'true returns full page text in content (slower/larger)'},
               ori_question:{type:'string', description:'the original user question, improves intent matching'} } }
output.schema: { type:'object', additionalProperties:false, properties:{
               query:{type:'string'}, count:{type:'integer'}, elapsedMs:{type:'number'},
               results:{type:'array', items:{ type:'object', additionalProperties:false, properties:{
                 title:{type:'string'}, url:{type:'string'}, snippet:{type:'string'}, summary:{type:'string'},
                 content:{type:'string'}, siteName:{type:['string','null']}, siteIcon:{type:['string','null']},
                 date:{type:['string','null']}, rerankScore:{type:'number'}, authority:{type:'integer'} } } },
               } }
output.render(args, value) -> ContentBlock[]
isConcurrencySafe: () => true
timeoutMs: config.timeoutMs + 5000
```

`execute` returns the object described by `output.schema` (camelCase). `render` must produce compact
markdown-ish plain text for the model, roughly:

```
DeepSeek Search · "查询词" · 3 条结果 · 412ms
1. <title>
   <url>
   <summary || snippet>
2. …
（结果为空时输出：DeepSeek Search 未找到与 "…" 匹配的结果。）
```

Keep each entry ≤ ~700 chars; when `need_content` was requested include a short `content` excerpt
(first ~400 chars, single line).

Failures throw `new Error(message)` with actionable text, e.g.
`DeepSeek Search API key is not configured. Set it in the DeepSeek Search panel (left sidebar) — it is stored as <apiKeyEnv>.`

### 3.4 HTTP endpoints

All three are `POST`, `requestBody: 'buffered'`, path prefix `/api/dsh-deepseek-search/`.
Every response is JSON with `cache-control: no-store`.

**`/api/dsh-deepseek-search/status`** → 200
```json
{ "ok": true, "value": {
    "configured": true, "source": "official", "sourceRef": "DEEPSEEK_API_KEY",
    "maskedKey": "sk-abc…8f2c",
    "apiKeyEnv": "DEEPSEEK_SEARCH_API_KEY",
    "official": { "enabled": true, "candidates": ["DEEPSEEK_API_KEY"] },
    "baseUrl": "https://api.deepseek.com",
    "toolName": "deepseek_search",
    "defaults": { "count": 10, "needContent": false } } }
```

`source` is `"own" | "official" | "config" | "env" | null` (the machine kind the client localizes);
`sourceRef` is the credential ref that produced the value, and is safe to show. `official.candidates`
lists ref **names** only, never values.

**`/api/dsh-deepseek-search/search`** body
```json
{ "query": "…", "count": 10, "needContent": false, "oriQuestion": "…", "localization": "" }
```
→ 200 `{ "ok": true, "value": { "query": "…", "count": 10, "elapsedMs": 412, "results": [ …camelCase result objects… ] } }`
→ 400/401/402/429/5xx `{ "ok": false, "error": { "code": "MISSING_API_KEY", "message": "…" } }`

**`/api/dsh-deepseek-search/key`** body `{ "apiKey": "sk-…" }`
- non-empty → `ctx.credentials.set(apiKeyEnv, trimmed)` then respond with the same payload as `status`
- empty string → `ctx.credentials.unset(apiKeyEnv)` then respond with `status`
Never echo the key back.

Error `code` values (keep these names, the client maps them to localized hints):
`MISSING_API_KEY`, `UNAUTHORIZED`, `INSUFFICIENT_BALANCE`, `FORBIDDEN`, `NOT_FOUND`, `TIMEOUT`,
`RATE_LIMITED`, `BAD_REQUEST`, `SERVER_ERROR`, `NETWORK_ERROR`, `BAD_RESPONSE`, `INTERNAL`.

Register each route inside `ctx.effect(() => ctx.connection.fetch.register({…}), 'label')` so HMR and
unload remove it. Duplicate (path) registration throws.

---

## 4. Host half — `deepseek-api.js`

No Cordis / no DSH imports. Pure, testable.

```js
export class DeepSeekSearchError extends Error {
  constructor(code, message, status) { super(message); this.name='DeepSeekSearchError'; this.code=code; this.status=status }
}

export function clampCount(value, fallback = 10)          // integer 1..50
export function normalizeBaseUrl(value)                    // strip trailing '/', default https://api.deepseek.com
export function maskKey(key)                               // 'sk-abc…8f2c', '' -> ''
export function buildSearchRequest({ query, count, needContent, oriQuestion, localization })
export async function searchDeepSeek({
  apiKey, baseUrl, query, count, needContent, oriQuestion, localization,
  timeoutMs = 25000, signal, fetchImpl = fetch,
})   // -> { results: SearchResult[], elapsedMs: number }
export function mapResult(raw)                             // snake_case -> camelCase result object
export function describeError(status, body)                // -> { code, message }
```

`searchDeepSeek` must:
- throw `MISSING_API_KEY` when `apiKey` is falsy
- validate `query` (trim, non-empty, ≤128 chars) → `BAD_REQUEST`
- combine the caller `signal` with `AbortSignal.timeout(timeoutMs)` (abort on either)
- map `401→UNAUTHORIZED`, `402→INSUFFICIENT_BALANCE`, `403→FORBIDDEN`, `404→NOT_FOUND`,
  `408→TIMEOUT`, `413→BAD_REQUEST`, `429→RATE_LIMITED`, `5xx→SERVER_ERROR`, other `4xx→BAD_REQUEST`,
  network/abort → `NETWORK_ERROR`/`TIMEOUT`
- surface the upstream `error.message` when present, prefixed with the status
- return `{ results: [], elapsedMs }` for an empty `results` array (not an error)
- de-duplicate by `url`, dropping entries without a `url`
- never include the API key in any message

---

## 5. Client half — `client.js`

Module-loader artifact, exactly this envelope:

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-deepseek-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // …component definitions…
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const NS = 'dsh-deepseek-search'
        const ID = 'deepseek-search'
        ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }), 'dsh-deepseek-search: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID, locale: NS }, SearchPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: ID, order: 30, label: () => t('nav.label'), locale: NS },
          (props) => h(SidebarIcon, { size: props.size }),
        ))
      },
    }
  },
})
```

- `require('react')` is the only allowed module. No other Harness package, no CDN.
- Components receive the framework `t` seat as a prop because `locale: NS` was passed to `register` —
  still keep a module-scope `t` fallback captured in `apply` (`translate = t`) so nested helpers can use it.
- Factories must be side-effect free: no `document` access at factory time, no timers, no listeners.

### 5.1 Sidebar icon component

`({ size = 20, active, t })` → inline `<svg>` `viewBox="0 0 24 24"` with `width=height=size`,
`stroke="currentColor"`, `fill="none"`, `aria-hidden`. Draw an original magnifier-over-lens glint mark
(a rounded magnifier ring with a small sparkle inside, handle to bottom-right).
Color the glyph with `active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'`.

### 5.2 Main page component

Full-height page inside the main column. It owns its own scroll container. Layout:

```
┌ page ────────────────────────────────────────────────────────────┐
│ header:  DeepSeek 搜索 / DeepSeek Search          [status pill] [⚙]│
│          subtitle: 独立 DeepSeek API Key 驱动的网页搜索，任意模型可用   │
│ search bar: [ 🔍 输入关键词，支持 site: / lang: / after: … ] [搜索]  │
│ options row: 结果数 [5|10|20|50]  ·  抓取正文(toggle)                │
│ ── content ────────────────────────────────────────────────────── │
│ results list  |  empty state  |  loading skeleton  |  error card    │
└──────────────────────────────────────────────────────────────────┘
```

Behaviour:

- First mount: `POST api/dsh-deepseek-search/status` → shows configured / not-configured pill.
- `⚙` toggles an inline settings panel (not a modal) with:
  - masked key + source when configured
  - password input + 保存 / 清除 buttons (`POST api/dsh-deepseek-search/key`), then refresh status
  - a short note: key is stored via the Harness credential store under `apiKeyEnv`, separate from the
    model provider key; a link `<a href="https://api-docs.deepseek.com/zh-cn/guides/search" target="_blank" rel="noreferrer">` to the docs.
- Search: `POST api/dsh-deepseek-search/search`. Enter in the input submits; `⌘/Ctrl+Enter` in the
  textarea submits too. Show a spinner in the submit button, disable it while running.
- `AbortController` cancels an in-flight request when a new one starts or the component unmounts.
- Result card: favicon-ish letter chip, title as external link (`target="_blank" rel="noreferrer"`),
  truncated URL host+path, snippet text, meta row (`site_name` · date short form · score badge when
  `rerankScore >= 1.5` · authority badge when `authority >= 3`), expandable `summary` (and `content`
  when present) with a 展开/收起 toggle. Keep it dense and readable.
- Error card: localized headline from `error.code` + the raw `message` in a `<code>` line, plus a
  "去配置 Key" button when the code is `MISSING_API_KEY` / `UNAUTHORIZED` / `INSUFFICIENT_BALANCE`.
- Empty result: 未找到结果 suggestion row with 3 clickable example queries.
- Idle state: short intro + 4 clickable example query chips, e.g.
  `DeepSeek V4 发布`, `site:github.com deepseek agent`, `"精确短语" lang:zh after:2025`,
  `-site:example.com 模型评测`.

### 5.3 Styling rules

- **Only** these CSS custom properties for color, every one of them:
  `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`, `--dsw-alias-bg-layer-2`, `--dsw-alias-bg-overlay`,
  `--dsw-alias-border-l1`, `--dsw-alias-border-l2`, `--dsw-alias-brand-primary`,
  `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`, `--dsw-alias-state-error-primary`,
  `--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`,
  `--dsw-alias-state-idle-primary`, `--dsw-specific-sidebar-fill`.
  No literal colors anywhere (no `#fff`, no `rgba()`), no `--dsw-alias-label-tertiary` (not exposed).
- Class names all prefixed `dds-`.
- Render the stylesheet as a React element inside the page component:
  `<style>{CSS}</style>` — it disappears on unmount. The icon component needs no stylesheet.
- Inherit the host font stack (`font: inherit` / system stack) and let the container fill height:
  `height:100%; display:flex; flex-direction:column; overflow:hidden` on the page,
  `flex:1; overflow:auto` on the result scroll area.
- Light/dark both come free from the tokens — never branch on theme.

### 5.4 Locale dictionaries

Both `zh` and `en` must be complete (same key set). Keys (camelCase, nested via `nav.`, `page.`, etc.):

`nav.label`, `page.title`, `page.subtitle`, `search.placeholder`, `search.submit`, `search.count`,
`search.needContent`, `search.needContentHint`, `status.configured`, `status.notConfigured`,
`status.checking`, `settings.title`, `settings.keyLabel`, `settings.keyPlaceholder`, `settings.save`,
`settings.clear`, `settings.saved`, `settings.cleared`, `settings.note`, `settings.docs`,
`settings.source`, `results.count`, `results.expand`, `results.collapse`, `results.open`,
`results.empty`, `results.emptyHint`, `error.MISSING_API_KEY`, `error.UNAUTHORIZED`,
`error.INSUFFICIENT_BALANCE`, `error.FORBIDDEN`, `error.NOT_FOUND`, `error.TIMEOUT`,
`error.RATE_LIMITED`, `error.BAD_REQUEST`, `error.NETWORK_ERROR`, `error.SERVER_ERROR`,
`error.BAD_RESPONSE`, `error.INTERNAL`, `error.configureKey`, `idle.title`, `idle.examples`,
`meta.quality`, `meta.authority`, `time.seconds`.

The `locale/en.json` + `locale/zh.json` **files** are only display metadata (`meta.title`,
`meta.description`) read by Plugin Manager — the panel dictionaries live in `client.js`.

---

## 6. Ground rules

- Plain ESM JavaScript only; no `node:` imports in `client.js`; no `window`/`document` in `index.js`.
- Never log or return the API key.
- Every registration goes through `ctx.effect` / `ctx.on` so unload and HMR clean up.
- Keep both files self-contained; the teammate owning a file is the only writer of that file.
- `node --check` cannot parse ESM-with-`window` reliably — use `node --input-type=module --check` or
  `node --check` on a `.mjs` copy for `index.js`, and for `client.js` wrap it as
  `node -e "new Function(require('fs').readFileSync('client.js','utf8'))"` to prove it parses.
