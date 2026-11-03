/**
 * @local/dsh-deepseek-search — Client half (browser).
 *
 * Registers two Slot entries and one locale namespace:
 *   - main               : the full DeepSeek Search page (key `deepseek-search`)
 *   - sidebar.panellist  : the left-rail magnifier entry
 *
 * Talks to the Host half over the Fetch routes it registers:
 *   POST api/dsh-deepseek-search/status  -> { ok, value: { configured, source, maskedKey, … } }
 *   POST api/dsh-deepseek-search/search  -> { ok, value: { query, count, elapsedMs, results } }
 *   POST api/dsh-deepseek-search/key     -> { ok, value: <same payload as status> }
 *
 * Only `react` may be required. The factory is side-effect free: every DOM/network
 * touch happens inside `apply`, a React effect, or an event handler.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-deepseek-search',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'dsh-deepseek-search'
    const ID = 'deepseek-search'
    const API = 'api/dsh-deepseek-search'
    const PANEL_ID = 'dds-settings-panel'
    const ORI_ID = 'dds-ori-question'
    const DOCS_URL = 'https://api-docs.deepseek.com/zh-cn/guides/search'
    const ENV_FALLBACK = 'DEEPSEEK_SEARCH_API_KEY'
    const COUNTS = [5, 10, 20, 50]
    const SKELETON_ROWS = [0, 1, 2, 3, 4]
    const CONTENT_LIMIT = 1600

    // Every error code the Host can emit, so `error.<code>` always resolves.
    const ERROR_CODES = [
      'MISSING_API_KEY', 'UNAUTHORIZED', 'INSUFFICIENT_BALANCE', 'FORBIDDEN',
      'NOT_FOUND', 'TIMEOUT', 'RATE_LIMITED', 'BAD_REQUEST', 'NETWORK_ERROR',
      'SERVER_ERROR', 'BAD_RESPONSE', 'INTERNAL',
    ]
    const KEY_ERROR_CODES = ['MISSING_API_KEY', 'UNAUTHORIZED', 'INSUFFICIENT_BALANCE']

    // Query strings are data (SPEC §5.2), not user-facing copy.
    const EXAMPLES = [
      'DeepSeek V4 发布',
      'site:github.com deepseek agent',
      '"精确短语" lang:zh after:2025',
      '-site:example.com 模型评测',
    ]

    // `apply` overwrites this with the bound seat so nested helpers still resolve.
    let translate = function (key) {
      return key
    }

    function resolveT(props) {
      if (props && typeof props.t === 'function') return props.t
      return translate
    }

    // ---------------------------------------------------------------- helpers

    function messageOf(err) {
      if (err === null || err === undefined) return 'unknown error'
      if (typeof err === 'string') return err
      if (typeof err.message === 'string' && err.message) return err.message
      return String(err)
    }

    function safeUrl(value) {
      if (typeof value !== 'string' || !value) return null
      try {
        return new URL(value)
      } catch (err) {
        return null
      }
    }

    function externalHref(value) {
      const parsed = safeUrl(value)
      if (!parsed) return null
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      return parsed.href
    }

    // Display form for a web URL: host + path, nothing else. Non-web schemes
    // (javascript:, data:, mailto:) deliberately yield '' so they are never shown
    // as a link and never spell out a script payload.
    function hostPath(value) {
      const parsed = safeUrl(value)
      if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return ''
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : ''
      return parsed.host + path
    }

    function hostOf(value) {
      const parsed = safeUrl(value)
      return parsed ? parsed.host.replace(/^www\./i, '') : ''
    }

    // `date` arrives as ISO 8601; keep the calendar day and stay timezone-stable.
    function shortDate(value) {
      if (typeof value !== 'string' || !value) return ''
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
      if (match) return match[1] + '-' + match[2] + '-' + match[3]
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) return ''
      const pad = function (n) {
        return (n < 10 ? '0' : '') + n
      }
      return parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate())
    }

    function letterOf(result) {
      if (!result) return '?'
      const pool = (result.siteName || '') + ' ' + hostOf(result.url)
      const match = /[\p{L}\p{N}]/u.exec(pool)
      return match ? match[0].toUpperCase() : '?'
    }

    function secondsLabel(t, elapsedMs) {
      const ms = Number(elapsedMs)
      const seconds = Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0
      const text = seconds >= 10 ? String(Math.round(seconds)) : seconds.toFixed(1)
      return t('time.seconds', { n: text })
    }

    function clampContent(value) {
      if (typeof value !== 'string' || !value) return ''
      const flat = value.replace(/\s+/g, ' ').trim()
      if (flat.length <= CONTENT_LIMIT) return flat
      return flat.slice(0, CONTENT_LIMIT) + '…'
    }

    function numberBadge(value) {
      const n = Number(value)
      return Number.isFinite(n) ? n : 0
    }

    function clampCount(value) {
      const n = Math.round(Number(value))
      return COUNTS.indexOf(n) >= 0 ? n : 10
    }

    // Strip the operators that most often produce a zero-result page.
    function relaxQuery(query) {
      const relaxed = String(query || '')
        .replace(/\b(?:site|lang|after|before):\S+/gi, ' ')
        .replace(/-?"[^"]*"/g, ' ')
        .replace(/(^|\s)-\S+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return relaxed
    }

    function suggestionList(query) {
      const seen = []
      const push = function (value) {
        const text = String(value || '').trim()
        if (!text || seen.indexOf(text) >= 0 || text === String(query || '').trim()) return
        seen.push(text)
      }
      push(relaxQuery(query))
      EXAMPLES.forEach(push)
      return seen.slice(0, 3)
    }

    function isComposing(event) {
      if (!event) return false
      if (event.isComposing) return true
      if (event.nativeEvent && event.nativeEvent.isComposing) return true
      return event.keyCode === 229
    }

    // --------------------------------------------------------------- transport

    // POSTs JSON to a Host route. Never throws on transport/HTTP failure: returns
    // { ok: true, value } or { ok: false, error: { code, message } }. Aborts rethrow
    // so callers can drop superseded requests.
    async function postJson(path, body, signal) {
      const fetchImpl = typeof fetch === 'function' ? fetch : null
      if (!fetchImpl) {
        return { ok: false, error: { code: 'NETWORK_ERROR', message: 'fetch is not available in this runtime' } }
      }
      let response
      try {
        response = await fetchImpl(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: signal,
          cache: 'no-store',
          credentials: 'same-origin',
        })
      } catch (err) {
        if (err && err.name === 'AbortError') throw err
        return { ok: false, error: { code: 'NETWORK_ERROR', message: messageOf(err) } }
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (err) {
        payload = null
      }
      if (payload && typeof payload === 'object') {
        if (payload.ok === true) return { ok: true, value: payload.value }
        if (payload.ok === false && payload.error) {
          return {
            ok: false,
            error: {
              code: String(payload.error.code || 'INTERNAL'),
              message: String(payload.error.message || ''),
            },
          }
        }
      }
      // Diagnostic text only; it lands in the raw <code> line of the error card.
      return {
        ok: false,
        error: { code: 'BAD_RESPONSE', message: 'HTTP ' + response.status },
      }
    }

    // -------------------------------------------------------------- dictionaries

    const zhDict = {
      'nav.label': 'DeepSeek 搜索',
      'page.title': 'DeepSeek 搜索',
      'page.subtitle': '独立 DeepSeek API Key 驱动的网页搜索，任何模型都能用',
      'search.placeholder': '输入关键词，支持 site: / lang: / after: …',
      'search.submit': '搜索',
      'search.count': '结果数',
      'search.needContent': '抓取正文',
      'search.needContentHint': '返回完整网页正文，速度较慢、结果更大',
      'search.oriQuestion': '原始问题',
      'search.oriQuestionPlaceholder': '可选：用户的原始问题，帮助理解搜索意图',
      'status.configured': '已配置 Key',
      'status.notConfigured': '未配置 Key',
      'status.checking': '检查中…',
      'settings.title': '搜索设置',
      'settings.keyLabel': 'DeepSeek API Key',
      'settings.keyPlaceholder': 'sk-…',
      'settings.save': '保存',
      'settings.clear': '清除',
      'settings.saved': '已保存',
      'settings.cleared': '已清除',
      'settings.note': '独立 Key 通过 Harness 凭证库保存为 {env}，只在保存时写本机、不回显。没配独立 Key 时，会自动复用你在模型列表里配好的官方 DeepSeek Key。',
      'settings.docs': 'DeepSeek 搜索 API 文档',
      'settings.source': '来源：{source}',
      'source.own': '独立 Key',
      'source.official': '模型列表的官方 Key',
      'source.officialRef': '模型列表的官方 Key（{ref}）',
      'source.config': '配置文件内联',
      'source.env': '环境变量',
      'source.envRef': '环境变量（{ref}）',
      'results.count': '{n} 条结果',
      'results.expand': '展开',
      'results.collapse': '收起',
      'results.open': '打开',
      'results.empty': '未找到结果',
      'results.emptyHint': '换个说法，或放宽 site: / 引号 / -排除 等条件后再试。',
      'error.MISSING_API_KEY': '还没有配置 DeepSeek API Key',
      'error.UNAUTHORIZED': 'API Key 无效或已失效',
      'error.INSUFFICIENT_BALANCE': '账户余额不足',
      'error.FORBIDDEN': '请求被拒绝',
      'error.NOT_FOUND': '搜索接口暂不可用',
      'error.TIMEOUT': '请求超时',
      'error.RATE_LIMITED': '请求过于频繁，请稍后再试',
      'error.BAD_REQUEST': '请求参数不合法',
      'error.NETWORK_ERROR': '网络连接失败',
      'error.SERVER_ERROR': '搜索服务暂时不可用',
      'error.BAD_RESPONSE': '返回数据无法解析',
      'error.INTERNAL': '插件内部错误',
      'error.configureKey': '去配置 Key',
      'idle.title': '输入关键词开始搜索。',
      'idle.examples': '可以试试：',
      'meta.quality': '相关度',
      'meta.authority': '权威度',
      'time.seconds': '{n} 秒',
    }

    const enDict = {
      'nav.label': 'DeepSeek Search',
      'page.title': 'DeepSeek Search',
      'page.subtitle': 'Web search on a standalone DeepSeek API key — any model can use it',
      'search.placeholder': 'Search the web — site:, lang:, after: … supported',
      'search.submit': 'Search',
      'search.count': 'Results',
      'search.needContent': 'Fetch page text',
      'search.needContentHint': 'Returns the full page text; slower and larger',
      'search.oriQuestion': 'Original question',
      'search.oriQuestionPlaceholder': 'Optional: the original question, for better intent matching',
      'status.configured': 'Key configured',
      'status.notConfigured': 'No API key',
      'status.checking': 'Checking…',
      'settings.title': 'Search settings',
      'settings.keyLabel': 'DeepSeek API Key',
      'settings.keyPlaceholder': 'sk-…',
      'settings.save': 'Save',
      'settings.clear': 'Clear',
      'settings.saved': 'Saved',
      'settings.cleared': 'Cleared',
      'settings.note': 'The standalone key is stored through the Harness credential store as {env}; it is written only when you save it and never echoed back. When it is unset, the official DeepSeek key configured for the model provider is reused automatically.',
      'settings.docs': 'DeepSeek Search API docs',
      'settings.source': 'Source: {source}',
      'source.own': 'standalone key',
      'source.official': 'official key from the model list',
      'source.officialRef': 'official key from the model list ({ref})',
      'source.config': 'inline config',
      'source.env': 'environment variable',
      'source.envRef': 'environment variable ({ref})',
      'results.count': '{n} results',
      'results.expand': 'More',
      'results.collapse': 'Less',
      'results.open': 'Open',
      'results.empty': 'No results',
      'results.emptyHint': 'Try different wording, or relax site:, quotes and -exclusions.',
      'error.MISSING_API_KEY': 'No DeepSeek API key yet',
      'error.UNAUTHORIZED': 'The API key is invalid or expired',
      'error.INSUFFICIENT_BALANCE': 'The account balance is insufficient',
      'error.FORBIDDEN': 'The request was blocked',
      'error.NOT_FOUND': 'The search endpoint is unavailable',
      'error.TIMEOUT': 'The request timed out',
      'error.RATE_LIMITED': 'Too many requests — try again shortly',
      'error.BAD_REQUEST': 'The request parameters were rejected',
      'error.NETWORK_ERROR': 'The network request failed',
      'error.SERVER_ERROR': 'The search service is temporarily unavailable',
      'error.BAD_RESPONSE': 'The response could not be parsed',
      'error.INTERNAL': 'Internal plugin error',
      'error.configureKey': 'Configure key',
      'idle.title': 'Type a query to search the web.',
      'idle.examples': 'Try one of these:',
      'meta.quality': 'Relevance',
      'meta.authority': 'Authority',
      'time.seconds': '{n}s',
    }

    // ------------------------------------------------------------------ styles
    //
    // Colour comes exclusively from the Host alias tokens; light/dark both fall
    // out of them. The sheet is rendered inside the page component so it is
    // removed with the panel.

    const CSS = `
.dds-page{
  height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13px;line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.dds-page *{box-sizing:border-box}
.dds-pad{
  padding-left:max(20px,calc((100% - 880px) / 2));
  padding-right:max(20px,calc((100% - 880px) / 2));
}
.dds-head{flex:none;display:flex;align-items:flex-start;gap:14px;padding-top:16px;padding-bottom:12px}
.dds-head-main{flex:1;min-width:0}
.dds-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.dds-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.dds-subtitle{margin:3px 0 0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dds-icon-btn{
  appearance:none;flex:0 0 auto;display:grid;place-items:center;width:28px;height:28px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:7px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;
  transition:color .12s ease,border-color .12s ease,background .12s ease;
}
.dds-icon-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay)}
.dds-icon-btn[aria-expanded="true"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}

.dds-pill{
  appearance:none;display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:999px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:10.5px;line-height:1;white-space:nowrap;cursor:pointer;
}
.dds-pill:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dds-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary)}
.dds-pill.dds-is-ok .dds-dot{background:var(--dsw-alias-state-success-primary)}
.dds-pill.dds-is-warn .dds-dot{background:var(--dsw-alias-state-warn-primary)}
.dds-pill.dds-is-err .dds-dot{background:var(--dsw-alias-state-error-primary)}
.dds-pill.dds-is-checking .dds-dot{animation:dds-pulse 1.2s ease-in-out infinite}

.dds-search-wrap{flex:none;padding-bottom:0}
.dds-bar{display:flex;flex-direction:column;gap:0;margin:0}
.dds-field{
  display:flex;align-items:center;gap:8px;min-height:38px;padding:4px 4px 4px 11px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);
  transition:border-color .12s ease;
}
.dds-field:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dds-field-icon{display:flex;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dds-field:focus-within .dds-field-icon{color:var(--dsw-alias-brand-primary)}
.dds-input{
  flex:1;min-width:0;appearance:none;border:0;outline:none;background:transparent;
  font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);
}
.dds-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dds-go{
  appearance:none;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:28px;min-width:68px;padding:0 13px;border:1px solid var(--dsw-alias-brand-primary);border-radius:7px;
  background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);
  font:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer;
  transition:opacity .12s ease;
}
.dds-go:hover{opacity:.9}
.dds-go:disabled{cursor:default;opacity:.45}
.dds-progress{margin-top:8px;height:2px;border-radius:2px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.dds-progress-bar{height:100%;width:28%;border-radius:2px;background:var(--dsw-alias-brand-primary);animation:dds-slide 1.1s ease-in-out infinite}

.dds-ori{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.dds-field-label{font-size:10.5px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}
.dds-textarea{
  width:100%;min-height:46px;max-height:180px;resize:vertical;
  padding:7px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;line-height:1.55;outline:none;
}
.dds-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dds-textarea::placeholder{color:var(--dsw-alias-label-secondary)}

.dds-opts{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:9px 0 11px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dds-opt{display:inline-flex;align-items:center;gap:6px}
.dds-opt-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dds-select{
  appearance:auto;height:24px;padding:0 5px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;
}
.dds-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dds-toggle{position:relative;display:inline-flex;align-items:center;gap:7px;cursor:pointer}
.dds-check{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.dds-switch{
  position:relative;flex:0 0 auto;width:26px;height:15px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  transition:background .12s ease,border-color .12s ease;
}
.dds-switch::after{
  content:'';position:absolute;top:2px;left:2px;width:9px;height:9px;border-radius:50%;
  background:var(--dsw-alias-label-secondary);transition:transform .12s ease,background .12s ease;
}
.dds-check:checked + .dds-switch{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dds-check:checked + .dds-switch::after{transform:translateX(11px);background:var(--dsw-alias-bg-base)}
.dds-check:focus-visible + .dds-switch{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dds-opt-hint{font-size:10.5px;color:var(--dsw-alias-label-secondary);min-width:0}
.dds-meta-grow{flex:1 1 auto;min-width:0}
.dds-ghost{
  appearance:none;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;
  border:1px dashed var(--dsw-alias-border-l1);border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;
}
.dds-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay)}

.dds-settings{
  flex:none;margin:12px max(20px,calc((100% - 880px) / 2)) 0;padding:12px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:9px;
}
.dds-settings-head{display:flex;align-items:center;gap:8px}
.dds-settings-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dds-key-state{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dds-key-masked{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary)}
.dds-key-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dds-key-form{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dds-key-input{
  flex:1 1 200px;min-width:140px;height:29px;padding:0 9px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;
}
.dds-key-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dds-key-input::placeholder{color:var(--dsw-alias-label-secondary)}
.dds-btn{
  appearance:none;display:inline-flex;align-items:center;height:29px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:7px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;transition:opacity .12s ease,border-color .12s ease;
}
.dds-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dds-btn:disabled{cursor:default;opacity:.45}
.dds-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}
.dds-btn-quiet{background:transparent}
.dds-note{margin:0;font-size:10.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.dds-note-ok{color:var(--dsw-alias-state-success-primary)}
.dds-note-err{color:var(--dsw-alias-state-error-primary)}
.dds-docs{
  align-self:flex-start;font-size:11px;color:var(--dsw-alias-brand-primary);
  text-decoration:none;border-bottom:1px solid transparent;
}
.dds-docs:hover{border-bottom-color:var(--dsw-alias-brand-primary)}

.dds-scroll{
  flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent;
}
.dds-list-head{
  position:sticky;top:0;z-index:2;display:flex;align-items:baseline;gap:8px;
  padding-top:9px;padding-bottom:8px;background:var(--dsw-alias-bg-base);
  border-bottom:1px solid var(--dsw-alias-border-l1);
}
.dds-list-head-count{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dds-list-head-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dds-list{display:flex;flex-direction:column;gap:8px;padding-top:10px;padding-bottom:26px}

.dds-hit{
  display:flex;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;background:var(--dsw-alias-bg-layer-1);
  transition:border-color .12s ease,background .12s ease;
}
.dds-hit:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay)}
.dds-chip{
  flex:0 0 auto;display:grid;place-items:center;width:20px;height:20px;border-radius:5px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:600;line-height:1;
}
.dds-hit-body{flex:1;min-width:0}
.dds-hit-title{
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  font-size:13px;font-weight:600;line-height:1.45;color:var(--dsw-alias-label-primary);
  text-decoration:none;word-break:break-word;
}
a.dds-hit-title:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px}
.dds-hit-url{
  margin-top:1px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:10.5px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.dds-hit-snip{
  margin:5px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.dds-hit.dds-is-open .dds-hit-snip{display:block;overflow:visible;-webkit-line-clamp:unset}
.dds-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dds-meta-site{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dds-meta-date::before{content:'·';margin-right:6px;color:var(--dsw-alias-label-secondary)}
.dds-tag{
  display:inline-flex;align-items:center;gap:4px;height:15px;padding:0 5px;border-radius:4px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary);
}
.dds-tag b{font-weight:600;color:var(--dsw-alias-label-primary)}
.dds-link-btn{
  appearance:none;border:0;background:none;padding:0;font:inherit;font-size:10.5px;
  color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:none;white-space:nowrap;
}
.dds-link-btn:hover{text-decoration:underline;text-underline-offset:2px}
.dds-more{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px}
.dds-summary{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);word-break:break-word}
.dds-content{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word}

.dds-idle{padding-top:26px;padding-bottom:26px;display:flex;flex-direction:column;gap:6px}
.dds-idle-title{margin:0;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.dds-idle-sub{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dds-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:6px}
.dds-chip-btn{
  appearance:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  padding:5px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font:inherit;font-size:11.5px;line-height:1.3;cursor:pointer;transition:color .12s ease,border-color .12s ease,background .12s ease;
}
.dds-chip-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-overlay)}

.dds-empty{padding-top:26px;padding-bottom:26px;display:flex;flex-direction:column;gap:6px}
.dds-empty-title{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dds-empty-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}

.dds-error{
  margin:16px max(20px,calc((100% - 880px) / 2)) 0;display:flex;flex-direction:column;gap:8px;padding:12px;
  border:1px solid var(--dsw-alias-border-l1);border-left:2px solid var(--dsw-alias-state-error-primary);
  border-radius:10px;background:var(--dsw-alias-bg-layer-1);
}
.dds-error-title{margin:0;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dds-error-code{
  display:block;margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap;word-break:break-word;
}
.dds-error-actions{display:flex;align-items:center;gap:8px}

.dds-skel-list{display:flex;flex-direction:column;gap:8px;padding-top:12px;padding-bottom:26px}
.dds-skel{
  display:flex;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;background:var(--dsw-alias-bg-layer-1);
}
.dds-skel-chip{flex:0 0 auto;width:20px;height:20px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);animation:dds-pulse 1.3s ease-in-out infinite}
.dds-skel-lines{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.dds-skel-line{height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);animation:dds-pulse 1.3s ease-in-out infinite}
.dds-w60{width:60%}
.dds-w80{width:80%}
.dds-w95{width:95%}

.dds-spin{animation:dds-spin .8s linear infinite;transform-origin:50% 50%}

@keyframes dds-pulse{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes dds-spin{to{transform:rotate(360deg)}}
@keyframes dds-slide{0%{transform:translateX(-110%)}100%{transform:translateX(420%)}}

@media (prefers-reduced-motion:reduce){
  .dds-page *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
}
`

    // ------------------------------------------------------------------- glyphs

    function SlidersIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { key: 'r1a', d: 'M3.5 7h8.5' }),
        h('path', { key: 'r1b', d: 'M16.5 7h4' }),
        h('circle', { key: 'k1', cx: 14.5, cy: 7, r: 2 }),
        h('path', { key: 'r2a', d: 'M3.5 12h3.5' }),
        h('path', { key: 'r2b', d: 'M11.5 12h9' }),
        h('circle', { key: 'k2', cx: 9.5, cy: 12, r: 2 }),
        h('path', { key: 'r3a', d: 'M3.5 17h10' }),
        h('path', { key: 'r3b', d: 'M18 17h2.5' }),
        h('circle', { key: 'k3', cx: 16, cy: 17, r: 2 }),
      )
    }

    function SearchGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 15
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', { key: 'ring', cx: 10.6, cy: 10.6, r: 6.2 }),
        h('path', { key: 'handle', d: 'M15.4 15.4 20.2 20.2' }),
      )
    }

    function Spinner(props) {
      const size = props && typeof props.size === 'number' ? props.size : 13
      return h(
        'svg',
        {
          className: 'dds-spin',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M12 3.5a8.5 8.5 0 0 1 8.5 8.5' }),
      )
    }

    // ------------------------------------------------------------- sidebar icon
    //
    // Original mark, same motif as icon.svg: magnifier ring, glint inside,
    // handle to the bottom-right. Reads at 16–24px in both rail states.

    function SidebarIcon(props) {
      const { size = 20, active = false } = props || {}
      const color = active
        ? 'var(--dsw-alias-brand-primary)'
        : 'var(--dsw-alias-label-secondary)'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
          style: { color: color, display: 'block', flex: '0 0 auto' },
        },
        h('circle', { key: 'ring', cx: 10.4, cy: 10.4, r: 6.3 }),
        h('path', { key: 'handle', d: 'M15.55 15.55 20.3 20.3', strokeWidth: 2.1 }),
        h('path', {
          key: 'glint',
          d: 'M10.4 7.5Q10.4 9.4 13.3 10.4Q10.4 11.4 10.4 13.3Q10.4 11.4 7.5 10.4Q10.4 9.4 10.4 7.5Z',
          fill: 'currentColor',
          stroke: 'none',
        }),
      )
    }

    // ------------------------------------------------------------- status pill

    function StatusPill(props) {
      const t = resolveT(props)
      const state = props.state
      let cls = 'dds-pill dds-is-checking'
      let label = t('status.checking')
      if (state === 'ready') {
        const configured = !!(props.configured)
        cls = 'dds-pill ' + (configured ? 'dds-is-ok' : 'dds-is-warn')
        label = configured ? t('status.configured') : t('status.notConfigured')
      } else if (state === 'error') {
        cls = 'dds-pill dds-is-err'
        label = t('status.notConfigured')
      }
      return h(
        'button',
        {
          type: 'button',
          className: cls,
          onClick: props.onClick,
          'aria-expanded': !!props.expanded,
          'aria-controls': PANEL_ID,
          title: t('settings.title'),
        },
        h('span', { key: 'dot', className: 'dds-dot', 'aria-hidden': true }),
        h('span', { key: 'label' }, label),
      )
    }

    // ------------------------------------------------------------- result card

    function ResultCard(props) {
      const t = resolveT(props)
      const result = props.result || {}
      const open = !!props.open
      const href = externalHref(result.url)
      const title = result.title || hostPath(result.url) || (typeof result.siteName === 'string' ? result.siteName : '') || String(result.url || '')
      const snippet = typeof result.snippet === 'string' ? result.snippet : ''
      const summary = typeof result.summary === 'string' ? result.summary : ''
      const content = clampContent(result.content)
      const siteName = typeof result.siteName === 'string' ? result.siteName : ''
      const date = shortDate(result.date)
      const score = numberBadge(result.rerankScore)
      const authority = numberBadge(result.authority)
      const hasMore = !!(summary || content)
      const key = result.url || String(props.index)

      const meta = h(
        'div',
        { key: 'meta', className: 'dds-meta' },
        siteName ? h('span', { key: 'site', className: 'dds-meta-site', title: siteName }, siteName) : null,
        date ? h('span', { key: 'date', className: 'dds-meta-date' }, date) : null,
        score >= 1.5
          ? h(
              'span',
              { key: 'score', className: 'dds-tag' },
              h('span', { key: 'l' }, t('meta.quality')),
              h('b', { key: 'v' }, score.toFixed(1)),
            )
          : null,
        authority >= 3
          ? h(
              'span',
              { key: 'auth', className: 'dds-tag' },
              h('span', { key: 'l' }, t('meta.authority')),
              h('b', { key: 'v' }, String(Math.round(authority))),
            )
          : null,
        h('span', { key: 'grow', className: 'dds-meta-grow', 'aria-hidden': true }),
        hasMore
          ? h(
              'button',
              {
                key: 'toggle',
                type: 'button',
                className: 'dds-link-btn',
                onClick: function () {
                  if (props.onToggle) props.onToggle(key)
                },
                'aria-expanded': open,
              },
              open ? t('results.collapse') : t('results.expand'),
            )
          : null,
        href
          ? h(
              'a',
              {
                key: 'open',
                className: 'dds-link-btn',
                href: href,
                target: '_blank',
                rel: 'noreferrer',
              },
              t('results.open'),
            )
          : null,
      )

      const more = open && hasMore
        ? h(
            'div',
            { key: 'more', className: 'dds-more' },
            summary ? h('p', { key: 'summary', className: 'dds-summary' }, summary) : null,
            content ? h('p', { key: 'content', className: 'dds-content' }, content) : null,
          )
        : null

      return h(
        'article',
        { className: 'dds-hit' + (open ? ' dds-is-open' : '') },
        h('span', { key: 'chip', className: 'dds-chip', 'aria-hidden': true }, letterOf(result)),
        h(
          'div',
          { key: 'body', className: 'dds-hit-body' },
          href
            ? h(
                'a',
                { className: 'dds-hit-title', href: href, target: '_blank', rel: 'noreferrer' },
                title,
              )
            : h('span', { className: 'dds-hit-title' }, title),
          hostPath(result.url)
            ? h('div', { className: 'dds-hit-url', title: String(result.url) }, hostPath(result.url))
            : null,
          snippet ? h('p', { className: 'dds-hit-snip' }, snippet) : null,
          meta,
          more,
        ),
      )
    }

    // ------------------------------------------------------------------ settings

    // Friendly, localized label for the Host-reported key origin. The Host sends
    // a machine kind (own | official | config | env) plus the credential ref that
    // produced the value; the raw ref name is data, so it interpolates as-is.
    function sourceLabel(t, status) {
      if (!status || !status.configured) return ''
      const kind = typeof status.source === 'string' ? status.source : ''
      const ref = typeof status.sourceRef === 'string' ? status.sourceRef : ''
      if (kind === 'own') return t('source.own')
      if (kind === 'official') return ref ? t('source.officialRef', { ref: ref }) : t('source.official')
      if (kind === 'config') return t('source.config')
      if (kind === 'env') return ref ? t('source.envRef', { ref: ref }) : t('source.env')
      return ''
    }

    function SettingsPanel(props) {
      const t = resolveT(props)
      const status = props.status || null
      const configured = !!(status && status.configured)
      const masked = (status && status.maskedKey) || ''
      const env = (status && status.apiKeyEnv) || ENV_FALLBACK
      const source = sourceLabel(t, status)
      const notice = props.notice
      const draft = typeof props.draft === 'string' ? props.draft : ''
      const busy = !!props.busy

      const stateRow = h(
        'div',
        { key: 'state', className: 'dds-key-state' },
        h('span', {
          key: 'dot',
          className: 'dds-dot',
          'aria-hidden': true,
          style: {
            background: configured
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-state-warn-primary)',
          },
        }),
        configured
          ? h('span', { key: 'masked', className: 'dds-key-masked' }, masked || env)
          : h('span', { key: 'none', className: 'dds-key-meta' }, t('status.notConfigured')),
        configured && source
          ? h('span', { key: 'src', className: 'dds-key-meta' }, t('settings.source', { source: source }))
          : null,
      )

      const noticeRow = notice
        ? h('p', {
            key: 'notice',
            className: 'dds-note ' + (notice.kind === 'ok' ? 'dds-note-ok' : 'dds-note-err'),
            role: 'status',
          }, notice.kind === 'ok' ? String(notice.text || '') : String(notice.message || ''))
        : null

      return h(
        'section',
        { className: 'dds-settings', id: PANEL_ID, 'aria-label': t('settings.title') },
        h(
          'div',
          { key: 'head', className: 'dds-settings-head' },
          h('h2', { className: 'dds-settings-title' }, t('settings.title')),
        ),
        stateRow,
        noticeRow,
        h(
          'div',
          { key: 'label', className: 'dds-field-label' },
          t('settings.keyLabel'),
        ),
        h(
          'div',
          { key: 'form', className: 'dds-key-form' },
          h('input', {
            className: 'dds-key-input',
            type: 'password',
            value: draft,
            placeholder: t('settings.keyPlaceholder'),
            autoComplete: 'off',
            spellCheck: false,
            'aria-label': t('settings.keyLabel'),
            onChange: function (event) {
              if (props.onDraft) props.onDraft(event.target.value)
            },
            onKeyDown: function (event) {
              if (event.key !== 'Enter' || isComposing(event)) return
              event.preventDefault()
              if (props.onSave) props.onSave()
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dds-btn dds-btn-primary',
              disabled: busy || !draft.trim(),
              onClick: function () {
                if (props.onSave) props.onSave()
              },
            },
            t('settings.save'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dds-btn dds-btn-quiet',
              disabled: busy || !configured,
              onClick: function () {
                if (props.onClear) props.onClear()
              },
            },
            t('settings.clear'),
          ),
        ),
        h('p', { key: 'note', className: 'dds-note' }, t('settings.note', { env: env })),
        h(
          'a',
          {
            key: 'docs',
            className: 'dds-docs',
            href: DOCS_URL,
            target: '_blank',
            rel: 'noreferrer',
          },
          t('settings.docs') + ' ↗',
        ),
      )
    }

    // -------------------------------------------------------------- list states

    function LoadingState(props) {
      return h(
        'div',
        { className: 'dds-skel-list dds-pad', 'aria-hidden': true },
        SKELETON_ROWS.map(function (row) {
          return h(
            'div',
            { key: row, className: 'dds-skel' },
            h('span', { key: 'chip', className: 'dds-skel-chip' }),
            h(
              'div',
              { key: 'lines', className: 'dds-skel-lines' },
              h('span', { key: 'a', className: 'dds-skel-line dds-w80' }),
              h('span', { key: 'b', className: 'dds-skel-line dds-w60' }),
              h('span', { key: 'c', className: 'dds-skel-line dds-w95' }),
            ),
          )
        }),
      )
    }

    function IdleState(props) {
      const t = resolveT(props)
      const onPick = props.onPick
      return h(
        'div',
        { className: 'dds-idle dds-pad' },
        h('p', { key: 'title', className: 'dds-idle-title' }, t('idle.title')),
        h('p', { key: 'sub', className: 'dds-idle-sub' }, t('idle.examples')),
        h(
          'div',
          { key: 'chips', className: 'dds-chips' },
          EXAMPLES.map(function (example) {
            return h(
              'button',
              {
                key: example,
                type: 'button',
                className: 'dds-chip-btn',
                title: example,
                onClick: function () {
                  if (onPick) onPick(example)
                },
              },
              example,
            )
          }),
        ),
      )
    }

    function EmptyState(props) {
      const t = resolveT(props)
      const picks = suggestionList(props.query)
      return h(
        'div',
        { className: 'dds-empty dds-pad' },
        h('p', { key: 'title', className: 'dds-empty-title' }, t('results.empty')),
        h('p', { key: 'hint', className: 'dds-empty-hint' }, t('results.emptyHint')),
        picks.length
          ? h(
              'div',
              { key: 'chips', className: 'dds-chips' },
              picks.map(function (pick) {
                return h(
                  'button',
                  {
                    key: pick,
                    type: 'button',
                    className: 'dds-chip-btn',
                    title: pick,
                    onClick: function () {
                      if (props.onPick) props.onPick(pick)
                    },
                  },
                  pick,
                )
              }),
            )
          : null,
      )
    }

    function ErrorState(props) {
      const t = resolveT(props)
      const error = props.error || {}
      const code = ERROR_CODES.indexOf(error.code) >= 0 ? error.code : 'INTERNAL'
      const canConfigure = KEY_ERROR_CODES.indexOf(code) >= 0
      return h(
        'div',
        { className: 'dds-error', role: 'alert' },
        h('p', { key: 'title', className: 'dds-error-title' }, t('error.' + code)),
        error.message ? h('code', { key: 'msg', className: 'dds-error-code' }, String(error.message)) : null,
        canConfigure
          ? h(
              'div',
              { key: 'actions', className: 'dds-error-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dds-btn dds-btn-primary',
                  onClick: function () {
                    if (props.onConfigure) props.onConfigure()
                  },
                },
                t('error.configureKey'),
              ),
            )
          : null,
      )
    }

    // -------------------------------------------------------------- search page

    function SearchPage(rawProps) {
      const t = resolveT(rawProps)

      const [status, setStatus] = useState(null)
      const [statusState, setStatusState] = useState('checking')
      const [settingsOpen, setSettingsOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [oriQuestion, setOriQuestion] = useState('')
      const [oriOpen, setOriOpen] = useState(false)
      const [count, setCount] = useState(10)
      const [needContent, setNeedContent] = useState(false)
      const [phase, setPhase] = useState('idle')
      const [results, setResults] = useState(null)
      const [meta, setMeta] = useState(null)
      const [error, setError] = useState(null)
      const [expanded, setExpanded] = useState({})
      const [keyDraft, setKeyDraft] = useState('')
      const [keyBusy, setKeyBusy] = useState(false)
      const [keyNotice, setKeyNotice] = useState(null)

      const alive = useRef(true)
      const defaultsApplied = useRef(false)
      const statusAbort = useRef(null)
      const searchAbort = useRef(null)
      const keyAbort = useRef(null)
      const requestSeq = useRef(0)
      const scrollRef = useRef(null)

      const applyStatus = useCallback(function (value) {
        const payload = value && typeof value === 'object' ? value : {}
        setStatus(payload)
        setStatusState('ready')
        if (!defaultsApplied.current && payload.defaults && typeof payload.defaults === 'object') {
          defaultsApplied.current = true
          setCount(clampCount(payload.defaults.count))
          setNeedContent(!!payload.defaults.needContent)
        }
      }, [])

      const loadStatus = useCallback(async function () {
        if (statusAbort.current) statusAbort.current.abort()
        const controller = new AbortController()
        statusAbort.current = controller
        setStatusState('checking')
        let response
        try {
          response = await postJson('/status', {}, controller.signal)
        } catch (err) {
          if (controller.signal.aborted || !alive.current) return
          setStatusState('error')
          return
        }
        if (controller.signal.aborted || !alive.current) return
        if (statusAbort.current === controller) statusAbort.current = null
        if (!response.ok) {
          setStatusState('error')
          return
        }
        applyStatus(response.value)
      }, [applyStatus])

      useEffect(function () {
        alive.current = true
        loadStatus()
        return function () {
          alive.current = false
          if (statusAbort.current) statusAbort.current.abort()
          if (searchAbort.current) searchAbort.current.abort()
          if (keyAbort.current) keyAbort.current.abort()
        }
      }, [loadStatus])

      const runSearch = useCallback(async function (override) {
        const raw = typeof override === 'string' ? override : query
        const text = raw.trim()
        if (!text) return

        if (searchAbort.current) searchAbort.current.abort()
        const controller = new AbortController()
        searchAbort.current = controller
        const seq = requestSeq.current + 1
        requestSeq.current = seq

        if (typeof override === 'string') setQuery(text)
        setPhase('loading')
        setError(null)
        setExpanded({})
        if (scrollRef.current) scrollRef.current.scrollTop = 0

        let response
        try {
          response = await postJson(
            '/search',
            {
              query: text,
              count: count,
              needContent: needContent,
              oriQuestion: oriQuestion.trim(),
              localization: '',
            },
            controller.signal,
          )
        } catch (err) {
          if (controller.signal.aborted || !alive.current || seq !== requestSeq.current) return
          setResults(null)
          setError({ code: 'NETWORK_ERROR', message: messageOf(err) })
          setPhase('error')
          return
        }
        if (controller.signal.aborted || !alive.current || seq !== requestSeq.current) return
        if (searchAbort.current === controller) searchAbort.current = null

        if (!response.ok) {
          const failure = response.error || {}
          setResults(null)
          setError({
            code: ERROR_CODES.indexOf(failure.code) >= 0 ? failure.code : 'INTERNAL',
            message: String(failure.message || ''),
          })
          setPhase('error')
          if (failure.code === 'MISSING_API_KEY') setSettingsOpen(true)
          return
        }

        const value = response.value && typeof response.value === 'object' ? response.value : {}
        const list = Array.isArray(value.results) ? value.results : []
        setResults(list)
        setMeta({
          query: typeof value.query === 'string' ? value.query : text,
          count: typeof value.count === 'number' ? value.count : count,
          elapsedMs: typeof value.elapsedMs === 'number' ? value.elapsedMs : 0,
        })
        setPhase('done')
      }, [query, count, needContent, oriQuestion])

      const toggleSettings = useCallback(function () {
        setSettingsOpen(function (open) {
          return !open
        })
        if (statusState === 'error') loadStatus()
      }, [statusState, loadStatus])

      const openSettings = useCallback(function () {
        setSettingsOpen(true)
        if (statusState !== 'ready') loadStatus()
      }, [statusState, loadStatus])

      const saveKey = useCallback(async function () {
        const value = keyDraft.trim()
        if (!value || keyBusy) return
        if (keyAbort.current) keyAbort.current.abort()
        const controller = new AbortController()
        keyAbort.current = controller
        setKeyBusy(true)
        setKeyNotice(null)
        let response
        try {
          response = await postJson('/key', { apiKey: value }, controller.signal)
        } catch (err) {
          if (controller.signal.aborted || !alive.current) return
          setKeyNotice({ kind: 'error', message: messageOf(err) })
          if (alive.current) setKeyBusy(false)
          return
        }
        if (controller.signal.aborted || !alive.current) return
        if (keyAbort.current === controller) keyAbort.current = null
        setKeyBusy(false)
        if (!response.ok) {
          const failure = response.error || {}
          setKeyNotice({ kind: 'error', message: String(failure.message || failure.code || '') })
          return
        }
        applyStatus(response.value)
        setKeyDraft('')
        setKeyNotice({ kind: 'ok', text: t('settings.saved') })
      }, [keyDraft, keyBusy, applyStatus, t])

      const clearKey = useCallback(async function () {
        if (keyBusy) return
        if (keyAbort.current) keyAbort.current.abort()
        const controller = new AbortController()
        keyAbort.current = controller
        setKeyBusy(true)
        setKeyNotice(null)
        let response
        try {
          response = await postJson('/key', { apiKey: '' }, controller.signal)
        } catch (err) {
          if (controller.signal.aborted || !alive.current) return
          setKeyNotice({ kind: 'error', message: messageOf(err) })
          if (alive.current) setKeyBusy(false)
          return
        }
        if (controller.signal.aborted || !alive.current) return
        if (keyAbort.current === controller) keyAbort.current = null
        setKeyBusy(false)
        if (!response.ok) {
          const failure = response.error || {}
          setKeyNotice({ kind: 'error', message: String(failure.message || failure.code || '') })
          return
        }
        applyStatus(response.value)
        setKeyDraft('')
        setKeyNotice({ kind: 'ok', text: t('settings.cleared') })
      }, [keyBusy, applyStatus, t])

      const toggleExpanded = useCallback(function (key) {
        setExpanded(function (open) {
          const next = Object.assign({}, open)
          next[key] = !next[key]
          return next
        })
      }, [])

      const busy = phase === 'loading'
      const trimmed = query.trim()

      const onSubmit = function (event) {
        event.preventDefault()
        runSearch()
      }

      const onInputKeyDown = function (event) {
        if (event.key !== 'Enter' || isComposing(event)) return
        event.preventDefault()
        runSearch()
      }

      const onOriKeyDown = function (event) {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
        event.preventDefault()
        runSearch()
      }

      const header = h(
        'header',
        { key: 'head', className: 'dds-head dds-pad' },
        h(
          'div',
          { key: 'main', className: 'dds-head-main' },
          h(
            'div',
            { key: 'title-row', className: 'dds-title-row' },
            h('h1', { key: 'title', className: 'dds-title' }, t('page.title')),
            h(StatusPill, {
              key: 'pill',
              t: t,
              state: statusState,
              configured: !!(status && status.configured),
              expanded: settingsOpen,
              onClick: toggleSettings,
            }),
          ),
          h('p', { key: 'sub', className: 'dds-subtitle' }, t('page.subtitle')),
        ),
        h(
          'button',
          {
            key: 'gear',
            type: 'button',
            className: 'dds-icon-btn',
            onClick: toggleSettings,
            'aria-expanded': settingsOpen,
            'aria-controls': PANEL_ID,
            'aria-label': t('settings.title'),
            title: t('settings.title'),
          },
          h(SlidersIcon, { size: 16 }),
        ),
      )

      const bar = h(
        'div',
        { key: 'search', className: 'dds-search-wrap dds-pad' },
        h(
          'form',
          { className: 'dds-bar', onSubmit: onSubmit, noValidate: true },
          h(
            'div',
            { key: 'field', className: 'dds-field' },
            h('span', { key: 'icon', className: 'dds-field-icon', 'aria-hidden': true }, h(SearchGlyph, { size: 15 })),
            h('input', {
              key: 'input',
              className: 'dds-input',
              type: 'text',
              value: query,
              maxLength: 128,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.placeholder'),
              autoComplete: 'off',
              spellCheck: false,
              enterKeyHint: 'search',
              onChange: function (event) {
                setQuery(event.target.value)
              },
              onKeyDown: onInputKeyDown,
            }),
            h(
              'button',
              {
                key: 'go',
                type: 'submit',
                className: 'dds-go',
                disabled: busy || !trimmed,
                'aria-label': t('search.submit'),
              },
              busy ? h(Spinner, { size: 13 }) : t('search.submit'),
            ),
          ),
          busy && results && results.length ? h('div', { key: 'progress', className: 'dds-progress', 'aria-hidden': true }, h('div', { className: 'dds-progress-bar' })) : null,
          oriOpen
            ? h(
                'div',
                { key: 'ori', className: 'dds-ori' },
                h('label', { key: 'label', className: 'dds-field-label', htmlFor: ORI_ID }, t('search.oriQuestion')),
                h('textarea', {
                  key: 'area',
                  id: ORI_ID,
                  className: 'dds-textarea',
                  rows: 2,
                  maxLength: 128,
                  value: oriQuestion,
                  placeholder: t('search.oriQuestionPlaceholder'),
                  spellCheck: false,
                  onChange: function (event) {
                    setOriQuestion(event.target.value)
                  },
                  onKeyDown: onOriKeyDown,
                }),
              )
            : null,
          h(
            'div',
            { key: 'opts', className: 'dds-opts' },
            h(
              'label',
              { key: 'count', className: 'dds-opt' },
              h('span', { className: 'dds-opt-label' }, t('search.count')),
              h(
                'select',
                {
                  className: 'dds-select',
                  value: String(count),
                  'aria-label': t('search.count'),
                  onChange: function (event) {
                    setCount(clampCount(event.target.value))
                  },
                },
                COUNTS.map(function (value) {
                  return h('option', { key: value, value: String(value) }, String(value))
                }),
              ),
            ),
            h(
              'label',
              { key: 'content', className: 'dds-toggle' },
              h('input', {
                className: 'dds-check',
                type: 'checkbox',
                checked: needContent,
                onChange: function (event) {
                  setNeedContent(!!event.target.checked)
                },
              }),
              h('span', { className: 'dds-switch', 'aria-hidden': true }),
              h('span', { className: 'dds-opt-label' }, t('search.needContent')),
            ),
            h('span', { key: 'hint', className: 'dds-opt-hint' }, t('search.needContentHint')),
            h('span', { key: 'grow', className: 'dds-meta-grow', 'aria-hidden': true }),
            h(
              'button',
              {
                key: 'ori-toggle',
                type: 'button',
                className: 'dds-ghost',
                'aria-expanded': oriOpen,
                onClick: function () {
                  setOriOpen(function (open) {
                    return !open
                  })
                },
              },
              h('span', { 'aria-hidden': true }, oriOpen ? '−' : '+'),
              h('span', null, t('search.oriQuestion')),
            ),
          ),
        ),
      )

      const settings = settingsOpen
        ? h(SettingsPanel, {
            key: 'settings',
            t: t,
            status: status,
            draft: keyDraft,
            busy: keyBusy,
            notice: keyNotice,
            onDraft: setKeyDraft,
            onSave: saveKey,
            onClear: clearKey,
          })
        : null

      let body
      if (busy && !(results && results.length)) {
        body = h(LoadingState, { key: 'loading' })
      } else if (results) {
        const head = h(
          'div',
          { key: 'listhead', className: 'dds-list-head dds-pad' },
          h('span', { key: 'count', className: 'dds-list-head-count' }, t('results.count', { n: results.length })),
          meta ? h('span', { key: 'elapsed', className: 'dds-list-head-meta' }, secondsLabel(t, meta.elapsedMs)) : null,
        )
        const list = results.length
          ? h(
              'div',
              { key: 'list', className: 'dds-list dds-pad' },
              results.map(function (result, index) {
                const key = (result && result.url) || 'i' + index
                return h(ResultCard, {
                  key: key,
                  t: t,
                  index: index,
                  result: result,
                  open: !!expanded[key],
                  onToggle: toggleExpanded,
                })
              }),
            )
          : h(EmptyState, { key: 'empty', t: t, query: meta && meta.query ? meta.query : trimmed, onPick: runSearch })
        body = [head, list]
      } else if (phase === 'error' && error) {
        body = h(ErrorState, { key: 'error', t: t, error: error, onConfigure: openSettings })
      } else {
        body = h(IdleState, { key: 'idle', t: t, onPick: runSearch })
      }

      const scroll = h(
        'div',
        {
          key: 'scroll',
          className: 'dds-scroll',
          ref: scrollRef,
          role: 'region',
          'aria-label': t('page.title'),
          'aria-busy': busy,
        },
        body,
      )

      return h('div', { className: 'dds-page' }, h('style', { key: 'css' }, CSS), header, bar, settings, scroll)
    }

    // ------------------------------------------------------------------- plugin

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }), 'dsh-deepseek-search: dictionaries')
        const t = ctx.locale.bind(NS)
        translate = t
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID, locale: NS }, SearchPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: ID, order: 30, label: () => t('nav.label'), locale: NS },
          (props) => h(SidebarIcon, { size: props.size, active: props.active }),
        ))
      },
    }
  },
})
