/**
 * Record version history: every change appends a snapshot, and only the newest
 * K snapshots per record stay in the log. Older ones collapse into one line of
 * fixed fields. `superseded`/`retracted` snapshots are never merged away.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const PROTECTED = new Set(['superseded', 'retracted'])

export function createVersions({ jsonl, summary, limit = 5 }) {
  const read = () => {
    if (!existsSync(jsonl)) return []
    return readFileSync(jsonl, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  const write = (rows) => {
    const tmp = `${jsonl}.tmp`
    writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
    try {
      renameSync(tmp, jsonl)
    } catch (error) {
      rmSync(tmp, { force: true })
      throw error
    }
  }

  return {
    jsonl,
    summary,

    /** Append one snapshot, then compact the log. */
    record(snapshot) {
      try {
        appendFileSync(jsonl, `${JSON.stringify(snapshot)}\n`, 'utf8')
      } catch {
        return
      }
      this.compact()
    },

    /** Keep the newest `limit` per record; summarise the rest. */
    compact() {
      const rows = read()
      const byId = new Map()
      for (const row of rows) {
        const list = byId.get(row.id) ?? []
        list.push(row)
        byId.set(row.id, list)
      }
      const keep = []
      const summaries = []
      for (const [id, list] of byId) {
        if (list.length <= limit) {
          keep.push(...list)
          continue
        }
        const droppable = list
          .slice(0, list.length - limit)
          .filter((row) => !PROTECTED.has(row.status))
        if (droppable.length === 0) {
          keep.push(...list)
          continue
        }
        const dropped = new Set(droppable)
        keep.push(...list.filter((row) => !dropped.has(row)))
        const first = droppable[0]
        const last = droppable[droppable.length - 1]
        summaries.push({
          t: last.t,
          id,
          merged: droppable.length,
          from: first.t,
          to: last.t,
          ops: [...new Set(droppable.map((row) => row.op))],
          claim: last.claim,
        })
      }
      if (summaries.length > 0) {
        try {
          appendFileSync(summary, summaries.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
        } catch {
          // summary loss degrades history detail, not memory correctness
        }
      }
      write(keep)
    },

    /** How many snapshots a record still has in the log. */
    count(id) {
      return read().filter((row) => row.id === id).length
    },
  }
}
