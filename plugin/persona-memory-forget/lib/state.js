/**
 * Durable per-record lifecycle state: deref history, protection windows and
 * flap counts. Rebuildable in principle, but losing it re-arms a record the user
 * already protected, so it is written atomically next to the records.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const DAY = 24 * 60 * 60 * 1000

export function addDays(date, days) {
  const base = new Date(`${date}T00:00:00Z`).getTime()
  if (Number.isNaN(base)) return date
  return new Date(base + days * DAY).toISOString().slice(0, 10)
}

/**
 * @param {string} file absolute path to state.json
 */
export function createState(file) {
  let data = { version: 1, records: {} }
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.records) data = parsed
    }
  } catch {
    // A corrupt state file must not stop the plugin; it only loses history.
    data = { version: 1, records: {} }
  }

  const save = () => {
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      try {
        renameSync(tmp, file)
      } catch (error) {
        rmSync(tmp, { force: true })
        throw error
      }
    } catch {
      // best effort: state loss degrades protection, not correctness
    }
  }

  const get = (id) => data.records[id] ?? { derefCount: 0 }

  return {
    file,
    get,

    /** Record one dereference and freeze the record once it flaps. */
    markDereferenced(id, today, limit = 3) {
      const record = { ...get(id) }
      record.derefCount = (record.derefCount ?? 0) + 1
      record.lastDerefAt = today
      if (record.derefCount >= limit) record.frozen = true
      data.records[id] = record
      save()
      return record
    },

    /** Auto re-record is blocked while this is true. */
    isCooling(id, today, days = 7) {
      const record = get(id)
      if (!record.lastDerefAt) return false
      return addDays(record.lastDerefAt, days) > today
    },

    /** The user asked for this record; automatic dereference must not touch it. */
    isProtected(id, today) {
      const record = get(id)
      return Boolean(record.protectedUntil) && record.protectedUntil >= today
    },

    protect(id, today, days = 30) {
      const record = { ...get(id), protectedUntil: addDays(today, days), boost: 1.5 }
      data.records[id] = record
      save()
      return record
    },

    isFrozen(id) {
      return Boolean(get(id).frozen)
    },

    /** Frozen records need an explicit user decision, not another auto pass. */
    unfreeze(id) {
      const record = { ...get(id), frozen: false, derefCount: 0 }
      data.records[id] = record
      save()
    },

    summary(today) {
      const entries = Object.entries(data.records)
      return {
        tracked: entries.length,
        protected: entries.filter(([, record]) => record.protectedUntil && record.protectedUntil >= today).length,
        frozen: entries.filter(([, record]) => record.frozen).length,
        cooling: entries.filter(([, record]) => record.lastDerefAt && addDays(record.lastDerefAt, 7) > today).length,
      }
    },
  }
}
