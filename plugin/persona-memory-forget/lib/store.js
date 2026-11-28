/**
 * Persona memory storage: markdown is the truth, audits are a sidecar.
 *
 * Layout under <home>/memory/<persona>/:
 *   rules.md      L0 norms and aims (user-written, fail-closed parsing)
 *   persona.md    L1 records (claims, constraints)
 *   memory.md     L2 records
 *   state.json    counters and flags (rebuildable)
 *   audit.jsonl   minimal append-only audit
 *   .lock         cross-process write lock
 *
 * Writes are tmp -> File.Replace, so a crash leaves either the old file or the
 * new one. Reads never create a missing file.
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createState } from './state.js'
import { createVersions } from './versions.js'

/** Resolve the harness home without assuming the Desktop env injects it. */
export function resolveHome(explicit) {
  if (explicit) return explicit
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

const sha = (text) => createHash('sha1').update(text).digest('hex').slice(0, 6)

/** Parse rules.md: `- [norm] text` or `- [aim] text`, tolerating editor-mangled bullets. */
export function parseRules(text) {
  const rules = []
  const lines = text.split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    // Markdown editors often rewrite "- [norm]" as "* \[norm]"; undo that first.
    const normalized = line.replace(/\\([\[\]])/g, '$1')
    const match = /^[-*+]\s*\[(norm|aim)\]\s*(.+)$/.exec(normalized)
    if (!match) {
      throw new Error(`rules.md:${index + 1}: unrecognised line ${JSON.stringify(raw)}`)
    }
    const [, tag, body] = match
    rules.push({ id: `L0-${tag}-${sha(body)}`, tag, text: body })
  })
  return rules
}

/** Parse one block file: `## <id>` followed by `- key: value` lines. */
export function parseBlocks(text, layer, label = layer) {
  const records = []
  let current = null
  const lines = text.split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('# ')) return
    if (line.startsWith('## ')) {
      if (current) records.push(current)
      const id = line.slice(3).trim()
      if (!id) throw new Error(`${label}:${index + 1}: empty record id`)
      current = { id, layer, fields: {}, raw: [] }
      return
    }
    if (!current) throw new Error(`${label}:${index + 1}: field outside a record`)
    const match = /^-\s*([A-Za-z_]+):\s*(.*)$/.exec(line)
    if (!match) throw new Error(`${label}:${index + 1}: unrecognised line ${JSON.stringify(raw)}`)
    current.fields[match[1]] = match[2]
    current.raw.push(raw)
  })
  if (current) records.push(current)
  return records.map((r) => ({
    id: r.id,
    layer: r.layer,
    claim: r.fields.claim ?? '',
    status: r.fields.status ?? 'active',
    scope: r.fields.scope ?? '',
    evidence: r.fields.evidence ?? '',
    expires: r.fields.expires ?? '',
    updated: r.fields.updated ?? '',
    fields: r.fields,
  }))
}

/** Render records back to block markdown, preserving field order. */
export function renderBlocks(records, title) {
  const out = [`# ${title}`, '']
  for (const record of records) {
    out.push(`## ${record.id}`)
    for (const [key, value] of Object.entries(record.fields ?? {})) out.push(`- ${key}: ${value}`)
    out.push('')
  }
  return out.join('\n')
}

/**
 * Open one persona's store.
 * @param {{persona?: string, home?: string}} options
 */
export function createStore(options = {}) {
  const persona = options.persona ?? 'default'
  const home = resolveHome(options.home)
  const root = join(home, 'memory', persona)
  const paths = {
    root,
    rules: join(root, 'rules.md'),
    persona: join(root, 'persona.md'),
    memory: join(root, 'memory.md'),
    state: join(root, 'state.json'),
    audit: join(root, 'audit.jsonl'),
    pending: join(root, 'pending_l1.md'),
    versions: join(root, 'versions.jsonl'),
    versionsSummary: join(root, 'versions.md'),
    diaryDir: join(root, `diary-${persona}`),
    lock: join(root, '.lock'),
  }

  const audit = (record) => {
    try {
      appendFileSync(paths.audit, `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`, 'utf8')
    } catch {
      // best-effort: audit must never block a write
    }
  }

  const ensureDir = () => {
    mkdirSync(root, { recursive: true })
    if (!existsSync(paths.rules)) {
      writeFileSync(paths.rules, [
        '# L0 准则（仅用户可改）',
        '# 每行一条：- [norm] 规则  或  - [aim] 方向',
        '# 解析失败时插件拒绝注入，宁可什么都不做',
        '',
      ].join('\n'), 'utf8')
    }
    for (const [file, title] of [[paths.persona, 'L1 人格'], [paths.memory, 'L2 记忆']]) {
      if (!existsSync(file)) writeFileSync(file, `# ${title}\n\n`, 'utf8')
    }
  }

  /** Atomic replace. `tmp -> replace` keeps a torn write out of the truth file. */
  const writeAtomic = (file, text) => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, text, 'utf8')
    try {
      renameSync(tmp, file)
    } catch (error) {
      rmSync(tmp, { force: true })
      throw error
    }
  }

  /** Cross-process exclusivity; busy is a refusal, never a wait. */
  const withLock = (fn) => {
    let fd
    try {
      fd = openSync(paths.lock, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error(`memory store busy: ${paths.lock}`)
      throw error
    }
    try {
      return fn()
    } finally {
      closeSync(fd)
      rmSync(paths.lock, { force: true })
    }
  }

  const readLayer = (file, layer) => {
    if (!existsSync(file)) return { records: [], error: null }
    try {
      return { records: parseBlocks(readFileSync(file, 'utf8'), layer, basename(file)), error: null }
    } catch (error) {
      return { records: [], error: String(error) }
    }
  }

  return {
    persona,
    home,
    paths,
    state: createState(paths.state),
    versions: createVersions({ jsonl: paths.versions, summary: paths.versionsSummary }),

    init() {
      ensureDir()
      audit({ kind: 'init', persona })
      return this
    },

    /** L0 is fail-closed: an unreadable rule file disables injection. */
    readRules() {
      try {
        return { rules: parseRules(readFileSync(paths.rules, 'utf8')), error: null }
      } catch (error) {
        return { rules: [], error: String(error) }
      }
    },

    readL1() {
      return readLayer(paths.persona, 'L1')
    },

    readL2() {
      return readLayer(paths.memory, 'L2')
    },

    /** Every searchable record, with its parse error if any. */
    readAll() {
      const l1 = this.readL1()
      const l2 = this.readL2()
      return {
        records: [...l1.records, ...l2.records],
        errors: [l1.error, l2.error].filter(Boolean),
      }
    },

    writeL1(records) {
      return withLock(() => {
        writeAtomic(paths.persona, renderBlocks(records, 'L1 人格'))
        audit({ kind: 'write', layer: 'L1', count: records.length })
      })
    },

    writeL2(records) {
      return withLock(() => {
        writeAtomic(paths.memory, renderBlocks(records, 'L2 记忆'))
        audit({ kind: 'write', layer: 'L2', count: records.length })
      })
    },

    /** Minimal audit is always written; detail stays optional. */
    log(record) {
      audit(record)
    },

    /**
     * Diary: an append-only copy of every fact written to memory.
     * Never read by the model and never part of persona memory — deleting the
     * file is the user's way to destroy information completely.
     */
    appendDiary(entry) {
      try {
        mkdirSync(paths.diaryDir, { recursive: true })
        const month = new Date().toISOString().slice(0, 7)
        const file = join(paths.diaryDir, `${month}.md`)
        if (!existsSync(file)) writeFileSync(file, `# 日记 · ${persona} · ${month}\n\n`, 'utf8')
        appendFileSync(file, entry, 'utf8')
        return file
      } catch {
        return null
      }
    },

    /**
     * Keep the active set bounded: the oldest undated records turn `dormant`
     * (recoverable by retrieval) once `maxActive` is exceeded.
     */
    demoteExcess(maxActive = 24) {
      const today = new Date().toISOString().slice(0, 10)
      const l2 = this.readL2()
      const active = l2.records.filter((record) => record.status === 'active')
      if (active.length <= maxActive) return { demoted: 0 }
      const need = active.length - maxActive
      const oldest = active
        .filter((record) => !record.expires)
        .sort((a, b) => (a.updated ?? '').localeCompare(b.updated ?? ''))
        .slice(0, need)
      if (oldest.length === 0) return { demoted: 0 }
      const ids = new Set(oldest.map((record) => record.id))
      const records = l2.records.map((record) => (ids.has(record.id)
        ? { ...record, status: 'dormant', updated: today, fields: { ...record.fields, status: 'dormant', updated: today } }
        : record))
      for (const record of oldest) {
        this.versions.record({ t: new Date().toISOString(), id: record.id, op: 'demote', status: 'dormant', claim: record.claim })
      }
      this.writeL2(records)
      audit({ kind: 'demote', count: oldest.length, maxActive })
      return { demoted: oldest.length }
    },

    /**
     * Expire dated records: an `expires` day that has passed turns the record
     * into `expired` — still on disk, still queryable by state, never injected.
     * @param {string} [today] ISO date, defaults to now
     * @returns {{expired: number}}
     */
    sweepExpired(today = new Date().toISOString().slice(0, 10)) {
      const l2 = this.readL2()
      let expired = 0
      const records = l2.records.map((record) => {
        if (record.status !== 'active') return record
        const due = record.expires
        if (!due || due >= today) return record
        expired += 1
        return {
          ...record,
          status: 'expired',
          updated: today,
          fields: { ...record.fields, status: 'expired', updated: today },
        }
      })
      if (expired > 0) {
        for (const record of l2.records) {
          if (record.status === 'active' && record.expires && record.expires < today) {
            this.versions.record({ t: new Date().toISOString(), id: record.id, op: 'expire', status: 'expired', claim: record.claim })
          }
        }
        this.writeL2(records)
        audit({ kind: 'expire', count: expired, today })
      }
      return { expired }
    },

    status() {
      const rules = this.readRules()
      const l1 = this.readL1()
      const l2 = this.readL2()
      const byStatus = (records) => records.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1
        return acc
      }, {})
      return {
        persona,
        root,
        rules: { count: rules.rules.length, norms: rules.rules.filter((r) => r.tag === 'norm').length, aims: rules.rules.filter((r) => r.tag === 'aim').length, error: rules.error },
        l1: { count: l1.records.length, byStatus: byStatus(l1.records), error: l1.error },
        l2: { count: l2.records.length, byStatus: byStatus(l2.records), error: l2.error },
      }
    },

    auditPath: paths.audit,
    lockPath: paths.lock,
  }
}






