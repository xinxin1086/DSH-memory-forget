/**
 * Per-turn injection: one durable user-role message carrying the pack.
 *
 * Cadence (D4): inject on the first step of a turn, and again only when the pack
 * text changes. State is process-local, so a restart re-injects once — harmless.
 */

import { randomUUID } from 'node:crypto'
import { buildPack, hashText } from './pack.js'

const SOURCE_KIND = 'dsh-memory-forget'

/** Root when the agent has no creator; unknown classification is treated as a child. */
export function isRootAgent(ctx, agent) {
  try {
    const names = ctx.subagents.namesOf(agent)
    return names?.parent == null
  } catch {
    return false
  }
}

/** Last user-authored text entering this step, used as the retrieval query. */
function queryFrom(decision) {
  const messages = decision?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.source?.kind !== 'user') continue
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join(' ')
    if (text) return text.slice(0, 500)
  }
  return ''
}

/**
 * @param {{ctx: object, store: object, config: object, log: Function}} options
 */
export function registerInjection({ ctx, store, config, log }) {
  /** sessionId -> { turn, hash } of the latest pack this process injected. */
  const injected = new Map()
  /** sessionId -> { turn, query } so later steps reuse the turn's original query. */
  const turnQuery = new Map()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const { agent, turn } = payload ?? {}
      if (!agent || decision?.kind === 'reject') return decision
      if (!config.enabled) return decision

      const sessionId = agent.session?.id
      if (!sessionId) return decision

      // The query comes from the turn's first user message; later steps have none.
      const cached = turnQuery.get(sessionId)
      const query = cached && cached.turn === turn ? cached.query : queryFrom(decision)
      if (!cached || cached.turn !== turn) turnQuery.set(sessionId, { turn, query })

      const isRoot = isRootAgent(ctx, agent)
      const pack = buildPack(store, { isRoot, query, limits: config.limits })
      if (!pack.text) {
        log({ kind: 'inject_skip', reason: 'pack-empty', detail: pack.reason ?? null })
        return decision
      }
      const previous = injected.get(sessionId)
      if (previous && previous.turn === turn && previous.hash === pack.hash) return decision

      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: pack.text }],
        source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: pack.text }] },
      }
      injected.set(sessionId, { turn, hash: pack.hash })
      log({ kind: 'inject', turn, isRoot, counts: pack.counts, chars: pack.text.length })
      return { ...decision, messages: [...(decision.messages ?? []), message] }
    } catch (error) {
      log({ kind: 'inject_error', error: String(error) })
      return decision
    }
  })
}

export { hashText }

