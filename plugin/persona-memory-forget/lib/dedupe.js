/**
 * Near-duplicate detection for memory claims.
 *
 * Exact text comparison is useless here: "我不吃香菜" and "用户不喜欢吃香菜"
 * describe one fact. Bigram Jaccard over punctuation-stripped text is cheap,
 * synchronous, and good enough to stop the store degrading into paraphrase soup.
 */

const NOISE = /[\s，。！？、；：,.!?;:"'「」『』（）()【】\[\]…~～\-—]/g

export function normalizeClaim(text) {
  return String(text ?? '').toLowerCase().replace(NOISE, '')
}

function bigrams(text) {
  const out = new Set()
  if (text.length === 1) out.add(text)
  for (let i = 0; i + 1 < text.length; i += 1) out.add(text.slice(i, i + 2))
  return out
}

/** Dice coefficient over bigrams: 1 means identical. */
export function similarity(a, b) {
  const left = normalizeClaim(a)
  const right = normalizeClaim(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const A = bigrams(left)
  const B = bigrams(right)
  let shared = 0
  for (const token of A) if (B.has(token)) shared += 1
  return (2 * shared) / (A.size + B.size)
}

/**
 * Find the closest active record to `claim`.
 * @returns {{record: object, score: number}|null}
 */
export function findSimilar(records, claim, threshold = 0.55) {
  let best = null
  for (const record of records) {
    if (record.status !== 'active') continue
    const score = similarity(record.claim, claim)
    if (score >= threshold && (!best || score > best.score)) best = { record, score }
  }
  return best
}

/** True when `next` carries everything `previous` did plus new content. */
export function isSuperset(next, previous) {
  const a = normalizeClaim(next)
  const b = normalizeClaim(previous)
  return a.length > b.length && similarity(a, b) >= 0.55
}
