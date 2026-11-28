/**
 * Retrieval over memory records. Summary only by default: the raw block text
 * never leaves the machine unless the caller explicitly asks for it.
 */

const CJK = /[\u3400-\u9fff]/

/** Query -> searchable tokens. CJK becomes bigrams, Latin becomes words. */
export function tokenize(query) {
  const text = String(query ?? '').toLowerCase()
  const tokens = new Set()
  for (const word of text.match(/[a-z0-9_]{2,}/g) ?? []) tokens.add(word)
  const cjk = text.replace(/[^\u3400-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(cjk.slice(i, i + 2))
  if (cjk.length === 1) tokens.add(cjk)
  return [...tokens]
}

/** Score one record against tokens: claim weighs most, then scope, then id. */
export function scoreRecord(record, tokens) {
  if (tokens.length === 0) return record.status === 'active' ? 1 : 0
  const claim = (record.claim ?? '').toLowerCase()
  const scope = (record.scope ?? '').toLowerCase()
  const id = (record.id ?? '').toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (claim.includes(token)) score += 3
    if (scope.includes(token)) score += 2
    if (id.includes(token)) score += 1
  }
  return score
}

/**
 * @param {{records: Array<object>}} source records from the store
 * @param {{query?: string, states?: string[], limit?: number}} options
 * @returns {Array<object>} summaries, best first
 */
export function recall(source, options = {}) {
  const states = options.states?.length ? options.states : ['active']
  const limit = Math.min(Math.max(Number(options.limit ?? 8), 1), 50)
  const tokens = tokenize(options.query)
  return source.records
    .filter((record) => states.includes(record.status))
    .map((record) => ({ record, score: scoreRecord(record, tokens) }))
    .filter((entry) => tokens.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .slice(0, limit)
    .map(({ record, score }) => ({
      id: record.id,
      layer: record.layer,
      claim: record.claim,
      status: record.status,
      scope: record.scope || undefined,
      score,
    }))
}

const STATE_HINT = '默认只查 active；查已过期/已摘除/沉默的记忆要显式给 states（如 states=expired,dereferenced,dormant）'

/** Render recall output. `reveal` is the only path to raw text. */
export function formatRecall(hits, options = {}) {
  const where = options.query ? `query=${JSON.stringify(options.query)}` : 'no query'
  const states = options.states?.length ? options.states.join(',') : 'active'
  if (hits.length === 0) {
    return `没有命中任何记忆（${where}，states=${states}）。\n${STATE_HINT}`
  }
  const header = [
    `命中 ${hits.length} 条（${where}，states=${states}）。以下是摘要，不是原文。`,
  ]
  if (options.reveal) {
    header.unshift('⚠ 你请求了原文：以下内容来自本机记忆文件，会随会话日志上行。')
  }
  const lines = hits.map((hit) => {
    const scope = hit.scope ? ` scope=${hit.scope}` : ''
    return `- ${hit.id} [${hit.status}]${scope} ${hit.claim}`
  })
  return [...header, ...lines].join('\n')
}
