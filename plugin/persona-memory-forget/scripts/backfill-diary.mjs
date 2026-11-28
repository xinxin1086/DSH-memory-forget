/**
 * One-off diary backfill: copy existing L2 records into the diary with an
 * `backfill` marker. Idempotent — a record whose id already appears in any
 * diary file is skipped.
 *
 * Usage:
 *   node plugin/persona-memory-forget/scripts/backfill-diary.mjs [persona] [home]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'

const persona = process.argv[2] ?? 'default'
const home = process.argv[3]
const store = createStore({ persona, home }).init()

const seen = new Set()
if (existsSync(store.paths.diaryDir)) {
  for (const file of readdirSync(store.paths.diaryDir)) {
    if (!file.endsWith('.md')) continue
    const text = readFileSync(join(store.paths.diaryDir, file), 'utf8')
    for (const match of text.matchAll(/· (L2-[^\s·]+) ·/g)) seen.add(match[1])
  }
}

const records = store.readL2().records
let written = 0
for (const record of records) {
  if (seen.has(record.id)) continue
  const iso = new Date().toISOString()
  const lines = [`## ${iso} · ${record.id} · backfill`, `- claim: ${record.claim}`]
  if (record.scope) lines.push(`- scope: ${record.scope}`)
  if (record.expires) lines.push(`- expires: ${record.expires}`)
  lines.push(`- status: ${record.status}`, '', '')
  if (store.appendDiary(lines.join('\n'))) written += 1
}

store.log({ kind: 'diary_backfill', written, total: records.length, skipped: seen.size })
console.log(`diary backfill: wrote ${written}, skipped ${seen.size} already present, total records ${records.length}`)
console.log(`diary dir: ${store.paths.diaryDir}`)

