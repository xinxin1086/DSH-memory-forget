/**
 * History: K=5 version compaction and the append-only diary.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { applyOps } from '../lib/judge.js'

const noop = () => {}
const tempHome = () => mkdtempSync(join(tmpdir(), 'persona-memory-hist-'))
const seed = () => {
  const store = createStore({ persona: 'hist', home: tempHome() }).init()
  writeFileSync(store.paths.rules, '- [aim] 为用户带来快乐\n', 'utf8')
  return store
}

test('the diary keeps a copy of every fact that enters memory', () => {
  const store = seed()
  applyOps(store, [{ op: 'add_l2', claim: '用户有一只猫叫团子', scope: '谁=用户' }], noop)
  const month = new Date().toISOString().slice(0, 7)
  const file = join(store.paths.diaryDir, `${month}.md`)
  assert.ok(existsSync(file), 'diary file exists for the current month')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /用户有一只猫叫团子/)
  assert.match(text, /· add$|· add\n/m)
  assert.match(text, /- scope: 谁=用户/)

  // A later change in L2 must not rewrite the diary.
  const id = store.readL2().records.find((r) => r.claim.includes('团子')).id
  applyOps(store, [{ op: 'update_l2', id, claim: '用户有一只猫叫团子，三岁' }], noop)
  const after = readFileSync(file, 'utf8')
  assert.match(after, /用户有一只猫叫团子\n/, 'the original entry is untouched')
  assert.match(after, /用户有一只猫叫团子，三岁/, 'the update is appended, not merged')
})

test('the diary is never part of the memory file or the injected pack', () => {
  const store = seed()
  applyOps(store, [{ op: 'add_l2', claim: '用户怕打雷' }], noop)
  const memory = readFileSync(store.paths.memory, 'utf8')
  assert.doesNotMatch(memory, /日记|diary/)
})

test('version history compacts to five snapshots plus one summary line', () => {
  const store = seed()
  applyOps(store, [{ op: 'add_l2', claim: '用户喜欢跑步' }], noop)
  const id = store.readL2().records.find((r) => r.claim.includes('跑步')).id
  for (let i = 1; i <= 7; i += 1) {
    applyOps(store, [{ op: 'update_l2', id, claim: `用户喜欢跑步，每周${i}次` }], noop)
  }
  assert.ok(store.versions.count(id) <= 5, 'at most five snapshots remain')
  assert.ok(existsSync(store.paths.versionsSummary), 'older snapshots collapse into a summary')
  const summary = readFileSync(store.paths.versionsSummary, 'utf8')
  assert.match(summary, new RegExp(id))
  assert.match(summary, /"merged":/)
})

test('expiring a record leaves a version entry', () => {
  const store = seed()
  const record = {
    id: 'L2-due',
    layer: 'L2',
    claim: '用户明天要去取快递',
    status: 'active',
    expires: '2026-01-02',
    updated: '2026-01-01',
    fields: { claim: '用户明天要去取快递', status: 'active', expires: '2026-01-02', updated: '2026-01-01' },
  }
  store.writeL2([record])
  const result = store.sweepExpired('2026-01-03')
  assert.equal(result.expired, 1)
  assert.equal(store.readL2().records[0].status, 'expired')
  const log = readFileSync(store.paths.versions, 'utf8')
  assert.match(log, /"op":"expire"/)
})
