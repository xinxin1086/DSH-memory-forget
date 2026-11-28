/**
 * Model-facing tools. M1 is read-only: nothing here may change a record.
 */

import { formatRecall, recall } from './retrieve.js'
import { hashId } from './pack.js'

const text = (value) => [{ type: 'text', text: value }]

/**
 * Register memory tools on the plugin context.
 * @param {object} ctx cordis context with the `tools` service
 * @param {ReturnType<import('./store.js').createStore>} store persona store
 * @param {{log?: Function}} logger best-effort diagnostics sink
 */
export function registerTools(ctx, store, logger = {}) {
  const log = logger.log ?? (() => {})

  const recallTool = {
    name: 'memory_recall',
    description: [
      'Search this persona\'s long-term memory for records relevant to a question.',
      'Returns summaries with stable ids; raw text stays on this machine unless reveal is true.',
      'Use it when the user asks what you remember, or when a task needs something you may have stored before.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords, a phrase, or the question being answered.' },
      states: {
        type: 'string',
        description: 'Comma-separated record states, default "active". Use "active,dereferenced,dormant,expired" when the user asks what you forgot or what has passed.',
      },
      reveal: {
        type: 'boolean',
        description: 'Return raw record text. Only when the user explicitly asks for the original; the output will leave this machine with the session log.',
      },
      limit: { type: 'number', description: 'Maximum hits, 1-50. Default 8.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const states = String(args?.states ?? 'active')
        .split(',')
        .map((state) => state.trim())
        .filter(Boolean)
      const source = store.readAll()
      const hits = recall(source, { query: args?.query ?? '', states, limit: args?.limit ?? 8 })
      if (args?.reveal) {
        const raw = new Map(source.records.map((record) => [record.id, record.fields]))
        for (const hit of hits) hit.raw = raw.get(hit.id)
        store.log({ kind: 'tool', tool: 'memory_recall', reveal: true, ids: hits.map((h) => h.id) })
        const body = hits.map((hit) => {
          const fields = Object.entries(hit.raw ?? {}).map(([key, value]) => `  - ${key}: ${value}`)
          return [`- ${hit.id} [${hit.status}]`, ...fields].join('\n')
        })
        return ['⚠ 以下原文来自本机记忆文件，会随会话日志上行。', ...body].join('\n')
      }
      store.log({ kind: 'tool', tool: 'memory_recall', query: args?.query ?? '', hits: hits.length })
      return formatRecall(hits, { query: args?.query ?? '', states, reveal: false })
    },
  }

  const statusTool = {
    name: 'memory_status',
    description: 'Report this persona\'s memory layout: rule counts, layer sizes, parse errors and file paths. Read-only.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      const status = store.status()
      store.log({ kind: 'tool', tool: 'memory_status' })
      const lines = [
        `persona: ${status.persona}`,
        `root: ${status.root}`,
        `L0: ${status.rules.count} 条 (norm=${status.rules.norms}, aim=${status.rules.aims})${status.rules.error ? ` 解析失败: ${status.rules.error}` : ''}`,
        `L1: ${status.l1.count} 条 ${JSON.stringify(status.l1.byStatus)}${status.l1.error ? ` 解析失败: ${status.l1.error}` : ''}`,
        `L2: ${status.l2.count} 条 ${JSON.stringify(status.l2.byStatus)}${status.l2.error ? ` 解析失败: ${status.l2.error}` : ''}`,
        `state: ${JSON.stringify(store.state.summary(new Date().toISOString().slice(0, 10)))}`,
        `audit: ${store.auditPath}`,
      ]
      return lines.join('\n')
    },
  }

  const rememberTool = {
    name: 'memory_remember',
    description: 'Store something the user explicitly asked you to remember. Bypasses the automatic forgetting cooldown and protects the record for 30 days.',
    parameters: {
      text: { type: 'string', required: true, description: 'The fact to remember, as one concise sentence.' },
      expires: { type: 'string', description: 'Optional YYYY-MM-DD when the fact stops mattering.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      const claim = String(args?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      if (!claim) return 'nothing to remember: text was empty'
      const today = new Date().toISOString().slice(0, 10)
      const id = `L2-${hashId(claim)}`
      const records = store.readL2().records
      const existing = records.find((record) => record.id === id)
      if (existing) {
        existing.status = 'active'
        existing.claim = claim
        existing.updated = today
        existing.fields = { ...existing.fields, claim, status: 'active', updated: today }
      } else {
        records.push({
          id,
          layer: 'L2',
          claim,
          status: 'active',
          scope: '',
          evidence: 'E1',
          expires: typeof args?.expires === 'string' ? args.expires : '',
          updated: today,
          fields: {
            claim,
            status: 'active',
            ...(typeof args?.expires === 'string' ? { expires: args.expires } : {}),
            evidence: 'E1',
            updated: today,
          },
        })
      }
      store.writeL2(records)
      store.state.unfreeze(id)
      const protectedState = store.state.protect(id, today)
      const iso = new Date().toISOString()
      const expires = typeof args?.expires === 'string' ? args.expires : ''
      store.versions.record({ t: iso, id, op: 'remember', status: 'active', claim, scope: '', expires })
      store.appendDiary([`## ${iso} · ${id} · remember`, `- claim: ${claim}`, ...(expires ? [`- expires: ${expires}`] : []), '', ''].join('\n'))
      store.log({ kind: 'user_remember', id, claim })
      return `remembered ${id}: ${claim}\nprotected until ${protectedState.protectedUntil} (automatic forgetting will not touch it)`
    },
  }

  for (const definition of [recallTool, statusTool, rememberTool]) {
    try {
      ctx.tools.register(definition)
      log({ kind: 'tool_register', name: definition.name, result: 'ok' })
    } catch (error) {
      log({ kind: 'tool_register', name: definition.name, result: 'failed', error: String(error) })
      throw error
    }
  }
}
