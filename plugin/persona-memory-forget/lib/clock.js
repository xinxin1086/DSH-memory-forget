/**
 * Maintenance clock: candidates are enqueued while a turn runs; judging happens
 * when the turn stops, never on capacity thresholds.
 *
 * Trigger note: `turn/end` only reaches the global feed for subagent sessions in
 * this build (observed), so `agent/turn-stopping` is the primary trigger and the
 * session event stays as a secondary one. A short per-session debounce keeps the
 * two from judging twice.
 */

import { isRootAgent } from './inject.js'

const DEBOUNCE_MS = 1500

/**
 * @param {{ctx: object, store: object, runJudge: Function, config: object, log: Function}} options
 */
export function registerClock({ ctx, store, runJudge, config, log }) {
  /** sessionId -> pending candidate lines */
  const buffers = new Map()
  /** sessionId -> completed turns since the last run */
  const turns = new Map()
  const running = new Set()
  const lastFlush = new Map()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      const { agent } = payload ?? {}
      const sessionId = agent?.session?.id
      if (!sessionId || !isRootAgent(ctx, agent)) return decision
      const lines = (decision?.messages ?? [])
        .filter((message) => message?.source?.kind === 'user')
        .map((message) => (message.content ?? [])
          .filter((block) => block?.type === 'text')
          .map((block) => block.text)
          .join(' ')
          .trim()
          .slice(0, 800))
        .filter(Boolean)
      if (lines.length > 0) {
        const buffer = buffers.get(sessionId) ?? []
        buffer.push(...lines)
        buffers.set(sessionId, buffer.slice(-config.maxCandidates))
      }
    } catch (error) {
      log({ kind: 'clock_buffer_error', error: String(error) })
    }
    return decision
  })

  /** One flush attempt; both triggers funnel here. */
  const flush = (sessionId, source) => {
    try {
      if (!sessionId) return
      const now = Date.now()
      if (now - (lastFlush.get(sessionId) ?? 0) < DEBOUNCE_MS) {
        log({ kind: 'clock_skip', reason: 'debounce', source, sessionId })
        return
      }
      lastFlush.set(sessionId, now)

      // Dated records turn into `expired` here, not at read time.
      try {
        const swept = store.sweepExpired()
        if (swept.expired > 0) log({ kind: 'expire_sweep', count: swept.expired })
        const demoted = store.demoteExcess(config.maxActive)
        if (demoted.demoted > 0) log({ kind: 'demote_sweep', count: demoted.demoted, maxActive: config.maxActive })
      } catch (error) {
        log({ kind: 'expire_error', error: String(error) })
      }

      const agent = ctx.agents.list().find((item) => item.session?.id === sessionId)
      const root = agent ? isRootAgent(ctx, agent) : false
      const candidates = buffers.get(sessionId) ?? []
      log({ kind: 'clock_flush', source, sessionId, candidates: candidates.length, agentFound: Boolean(agent), isRoot: root })

      if ((turns.get(sessionId) ?? 0) + 1 < config.turnsPerRun) {
        turns.set(sessionId, (turns.get(sessionId) ?? 0) + 1)
        return
      }
      turns.set(sessionId, 0)
      buffers.set(sessionId, [])

      if (candidates.length === 0) {
        log({ kind: 'clock_skip', reason: 'no-candidates', sessionId })
        return
      }
      if (running.has(sessionId)) {
        log({ kind: 'clock_skip', reason: 'already-running', sessionId })
        return
      }
      if (!agent || !root) {
        log({ kind: 'clock_skip', reason: 'not-root-or-no-agent', sessionId })
        return
      }

      running.add(sessionId)
      log({ kind: 'judge_launch', sessionId, candidates: candidates.length })
      void runJudge({ ctx, store, sessionId, candidates, config: config.judge, log })
        .catch((error) => log({ kind: 'clock_error', error: String(error) }))
        .finally(() => running.delete(sessionId))
    } catch (error) {
      log({ kind: 'clock_error', error: String(error) })
    }
  }

  // Primary trigger: fires for both root and child agents before the turn closes.
  ctx.on('agent/turn-stopping', (payload, next) => {
    const sessionId = payload?.agent?.session?.id
    const result = typeof next === 'function' ? next() : undefined
    flush(sessionId, 'turn-stopping')
    return result
  })

  // Secondary trigger: observed for subagent sessions only in this build.
  ctx.on('session/event', (...args) => {
    const event = args[1]
    if (event?.type !== 'turn/end') return
    flush(args[0]?.id, 'turn-end')
  })
}
