/**
 * The memory judge: one auxiliary model call per maintenance run, producing a
 * small ops list. Raw candidates go to the model (the owner accepted that); what
 * lands on disk is summaries only.
 */

import { appendFileSync } from 'node:fs'
import { hashId } from './pack.js'
import { findSimilar, isSuperset, similarity } from './dedupe.js'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** The judge has no clock of its own; this is its only trustworthy "today". */
function todayContext(now = new Date()) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return { date, weekday: WEEKDAYS[now.getDay()] }
}

const SYSTEM = [
  '你是记忆裁判。输入包含 today（唯一可信的当前日期）、一批用户原话、当前准则与已有记忆摘要。',
  '你只能做四件事：',
  '1) add_l2：把值得长期记住的内容压成一条不超过 120 字的摘要；',
  '2) update_l2：当新内容与已有记录是同一事实（原意相同、只是说法不同或补充了细节），用它更新已有记录而不是新增；',
  '3) dereference_l2：把明显重复或已过时的记忆标记为摘除（不改原文）；',
  '4) propose_l1：提出一条核心人格新增提案，必须锚定一条准则 id。',
  '规则：',
  '- 所有相对时间（明天/后天/下周三/月底/下个月）必须先按 today 换算成绝对日期，claim 里不得保留相对表述。',
  '- 偏好、关系、重要决定：长期保留，不要 expires。',
  '- 计划、日程、一次性事务：加 "expires":"YYYY-MM-DD"，取事情结束的当天（例如"明天下午去买衣服"记成明天的日期，claim 写成"2026-11-29 下午去买衣服"）。这类必须记，过期会自然沉默。',
  '- scope 只写"谁=…;场景=…"，不要复述 claim 的内容。',
  '- 同一事实只有一条记录：说法不同就更新，补充细节也更新，不要并存。',
  '- 寒暄、天气、纯提问、已有内容：不要记。',
  '严格输出 JSON，不要解释：',
  '{"ops":[{"op":"add_l2","claim":"...","scope":"谁=某人;场景=...","expires":"2026-11-29"},{"op":"update_l2","id":"L2-xxxxxxx","claim":"..."},{"op":"dereference_l2","id":"L2-xxxxxxx"},{"op":"propose_l1","claim":"...","scope":"...","aims":["L0-aim-xxxxxx"]}]}',
  '没有可做的就输出 {"ops":[]}。',
].join('\n')

/** Extract and validate the ops list from model text. */
export function parseOps(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ops: [], error: 'no JSON object in reply' }
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    return { ops: [], error: `invalid JSON: ${String(error)}` }
  }
  if (!parsed || !Array.isArray(parsed.ops)) return { ops: [], error: 'missing ops array' }
  const ops = []
  for (const op of parsed.ops) {
    if (!op || typeof op.op !== 'string') continue
    if (op.op === 'add_l2' && typeof op.claim === 'string' && op.claim.trim()) {
      const expires = typeof op.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(op.expires) ? op.expires : undefined
      ops.push({ op: 'add_l2', claim: clean(op.claim), scope: op.scope ? clean(op.scope) : undefined, expires })
    } else if (op.op === 'update_l2' && typeof op.id === 'string') {
      const expires = typeof op.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(op.expires) ? op.expires : undefined
      ops.push({
        op: 'update_l2',
        id: clean(op.id),
        claim: typeof op.claim === 'string' && op.claim.trim() ? clean(op.claim) : undefined,
        scope: op.scope ? clean(op.scope) : undefined,
        expires,
      })
    } else if (op.op === 'dereference_l2' && typeof op.id === 'string') {
      ops.push({ op: 'dereference_l2', id: clean(op.id) })
    } else if (op.op === 'propose_l1' && typeof op.claim === 'string' && op.claim.trim()) {
      ops.push({ op: 'propose_l1', claim: clean(op.claim), scope: op.scope ? clean(op.scope) : '', aims: Array.isArray(op.aims) ? op.aims.map(clean) : [] })
    }
  }
  return { ops: ops.slice(0, 8), error: null }
}

const clean = (value) => String(value).replace(/\s+/g, ' ').trim().slice(0, 200)
const today = () => new Date().toISOString().slice(0, 10)

/** One diary entry: the fact as it was written, never edited afterwards. */
function diaryBlock(iso, op, id, claim, scope, expires) {
  const lines = [`## ${iso} · ${id} · ${op}`, `- claim: ${claim}`]
  if (scope) lines.push(`- scope: ${scope}`)
  if (expires) lines.push(`- expires: ${expires}`)
  lines.push('', '')
  return lines.join('\n')
}

/** Apply ops. Only add_l2 and dereference_l2 auto-apply; L1 goes to a proposal file. */
export function applyOps(store, ops, log) {
  const records = [...store.readL2().records]
  let added = 0
  let merged = 0
  let duplicate = 0
  let dereferenced = 0
  let cooling = 0
  let blocked = 0
  const proposals = []

  for (const op of ops) {
    if (op.op === 'add_l2') {
      // A paraphrase of a fact we already hold is not new information.
      const match = findSimilar(records, op.claim, 0.85)
      if (match) {
        if (isSuperset(op.claim, match.record.claim)) {
          match.record.claim = op.claim
          match.record.scope = op.scope ?? match.record.scope
          match.record.expires = op.expires ?? match.record.expires
          match.record.updated = today()
          match.record.fields = {
            ...match.record.fields,
            claim: op.claim,
            ...(op.scope ? { scope: op.scope } : {}),
            ...(op.expires ? { expires: op.expires } : {}),
            updated: today(),
          }
          merged += 1
          log({ kind: 'dedupe_merge', id: match.record.id, score: Number(match.score.toFixed(2)) })
        } else {
          duplicate += 1
          log({ kind: 'dedupe_skip', id: match.record.id, score: Number(match.score.toFixed(2)) })
        }
        continue
      }
      // A record the user asked to forget stays forgotten for the cooldown.
      const prior = records.find((item) => item.status === 'dereferenced' && similarity(item.claim, op.claim) >= 0.85)
      if (prior && (store.state.isFrozen(prior.id) || store.state.isCooling(prior.id, today()))) {
        cooling += 1
        log({ kind: 'cooling_block', id: prior.id, frozen: store.state.isFrozen(prior.id) })
        continue
      }
      const id = `L2-${hashId(op.claim)}`
      records.push({
        id,
        layer: 'L2',
        claim: op.claim,
        status: 'active',
        scope: op.scope ?? '',
        evidence: 'E1',
        expires: op.expires ?? '',
        updated: today(),
        fields: {
          claim: op.claim,
          status: 'active',
          ...(op.scope ? { scope: op.scope } : {}),
          ...(op.expires ? { expires: op.expires } : {}),
          evidence: 'E1',
          updated: today(),
        },
      })
      added += 1
      const iso = new Date().toISOString()
      store.versions.record({ t: iso, id, op: 'add', status: 'active', claim: op.claim, scope: op.scope ?? '', expires: op.expires ?? '' })
      store.appendDiary(diaryBlock(iso, 'add', id, op.claim, op.scope, op.expires))
    } else if (op.op === 'update_l2') {
      const record = records.find((item) => item.id === op.id && item.status === 'active')
      if (record && (op.claim || op.scope || op.expires)) {
        const claim = op.claim ?? record.claim
        record.claim = claim
        record.scope = op.scope ?? record.scope
        record.expires = op.expires ?? record.expires
        record.updated = today()
        record.fields = {
          ...record.fields,
          claim,
          ...(op.scope ? { scope: op.scope } : {}),
          ...(op.expires ? { expires: op.expires } : {}),
          updated: today(),
        }
        merged += 1
        const iso = new Date().toISOString()
        store.versions.record({ t: iso, id: record.id, op: 'update', status: 'active', claim, scope: record.scope ?? '', expires: record.expires ?? '' })
        store.appendDiary(diaryBlock(iso, 'update', record.id, claim, record.scope, record.expires))
        log({ kind: 'dedupe_update', id: record.id })
      }
    } else if (op.op === 'dereference_l2') {
      const record = records.find((item) => item.id === op.id && item.status === 'active')
      if (!record) continue
      if (store.state.isFrozen(record.id)) {
        blocked += 1
        log({ kind: 'frozen_skip', id: record.id })
        continue
      }
      if (store.state.isProtected(record.id, today())) {
        blocked += 1
        log({ kind: 'protected_skip', id: record.id, until: store.state.get(record.id).protectedUntil })
        continue
      }
      record.status = 'dereferenced'
      record.updated = today()
      record.fields = { ...record.fields, status: 'dereferenced', updated: today() }
      const tracked = store.state.markDereferenced(record.id, today())
      if (tracked.frozen) log({ kind: 'flap_frozen', id: record.id, count: tracked.derefCount })
      store.versions.record({ t: new Date().toISOString(), id: record.id, op: 'deref', status: 'dereferenced', claim: record.claim })
      dereferenced += 1
    } else if (op.op === 'propose_l1') {
      proposals.push(op)
    }
  }

  if (added > 0 || merged > 0 || dereferenced > 0) store.writeL2(records)

  if (proposals.length > 0) {
    const block = proposals.map((op) => [
      `## 待确认 L1-${hashId(op.claim)}`,
      `- claim: ${op.claim}`,
      `- status: proposed`,
      `- aims: ${op.aims.join(',') || '（未锚定）'}`,
      `- scope: ${op.scope || '（未限定）'}`,
      `- evidence: E1`,
      `- proposed: ${new Date().toISOString()}`,
      '',
    ].join('\n')).join('\n')
    try {
      appendFileSync(store.paths.pending, block, 'utf8')
    } catch (error) {
      log({ kind: 'proposal_write_failed', error: String(error) })
    }
  }
  return { added, merged, duplicate, dereferenced, cooling, blocked, proposed: proposals.length }
}

/**
 * Run one judge pass for a session.
 * @param {{ctx: object, store: object, sessionId: string, candidates: string[], config: object, log: Function}} options
 */
export async function runJudge({ ctx, store, sessionId, candidates, config, log }) {
  const agent = ctx.agents.list().find((item) => item.session?.id === sessionId)
  const model = agent?.model?.current?.()
  if (!model?.provider || !model?.model) {
    log({ kind: 'judge_skip', reason: 'no-model' })
    return { skipped: 'no-model' }
  }
  const rules = store.readRules()
  const existing = [...store.readL1().records, ...store.readL2().records]
    .filter((record) => record.status === 'active')
    .slice(0, 40)
    .map((record) => ({ id: record.id, claim: record.claim }))
  const input = JSON.stringify({
    today: todayContext(),
    rules: rules.rules.map((rule) => ({ id: rule.id, tag: rule.tag, text: rule.text })),
    existing,
    candidates,
  }, null, 0)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  const chunks = []
  try {
    for await (const chunk of ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: SYSTEM }] },
        { role: 'user', content: [{ type: 'text', text: input }] },
      ],
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && chunk.text) chunks.push(chunk.text)
    }
  } catch (error) {
    log({ kind: 'judge_error', error: String(error) })
    return { error: String(error) }
  } finally {
    clearTimeout(timer)
  }

  const raw = chunks.join('')
  const { ops, error } = parseOps(raw)
  // Keep the model's own wording: without it we cannot explain a zero-op run.
  log({ kind: 'judge_reply', raw: raw.slice(0, 400), ops: ops.length, error: error ?? null })
  if (error) {
    log({ kind: 'judge_parse_error', error, raw: raw.slice(0, 300) })
    return { error }
  }
  const applied = applyOps(store, ops, log)
  log({ kind: 'judge_done', ops: ops.length, ...applied, candidates: candidates.length })
  return { ops, applied }
}



