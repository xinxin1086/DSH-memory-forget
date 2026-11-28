/**
 * Persona memory plugin.
 *
 * M1: local markdown store + read-only recall tools.
 * M2: per-turn summary injection and an end-of-turn memory judge.
 */

import { createStore } from './lib/store.js'
import { registerTools } from './lib/tools.js'
import { registerInjection } from './lib/inject.js'
import { registerClock } from './lib/clock.js'
import { runJudge } from './lib/judge.js'

/** Cordis services this plugin needs. */
export const inject = ['tools', 'agents', 'llm', 'subagents']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{persona?: string, home?: string, inject?: object, judge?: object, clock?: object}} config
 */
export function apply(ctx, config = {}) {
  const store = createStore({ persona: config.persona, home: config.home })
  try {
    store.init()
  } catch (error) {
    store.log({ kind: 'init_failed', error: String(error) })
  }
  const log = store.log
  registerTools(ctx, store, { log })

  const injection = {
    enabled: config.inject?.enabled ?? true,
    limits: { maxL1: 3, maxL2: 8, maxChars: 3000, ...(config.inject?.limits ?? {}) },
  }
  if (injection.enabled) registerInjection({ ctx, store, config: injection, log })

  const judge = {
    enabled: config.judge?.enabled ?? true,
    maxCandidates: Math.max(5, Number(config.judge?.maxCandidates ?? 40)),
  }
  if (judge.enabled) {
    registerClock({
      ctx,
      store,
      runJudge,
      config: {
        turnsPerRun: Math.max(1, Number(config.clock?.turnsPerRun ?? 1)),
        maxCandidates: judge.maxCandidates,
        maxActive: Math.max(4, Number(config.clock?.maxActive ?? 24)),
        judge,
      },
      log,
    })
  }
}
