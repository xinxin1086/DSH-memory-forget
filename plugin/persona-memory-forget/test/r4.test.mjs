/**
 * R4: cooldown, protection and flap freeze. State lives in state.json and is
 * shared by the judge and the user-facing remember tool.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { createState, addDays } from '../lib/state.js'
import { applyOps } from '../lib/judge.js'
import { registerTools } from '../lib/tools.js'

const tempHome = () => mkdtempSync(join(tmpdir(), 'persona-memory-r4-'))
const seed = () => {
  const store = createStore({ persona: 'r4', home: tempHome() }).init()
  writeFileSync(store.paths.rules, '- [aim] 为用户带来快乐\n', 'utf8')
  return store
}
const noop = () => {}

test('state tracks deref counts, freezes after three, and expires protection', () => {
  const home = tempHome()
  const state = createState(join(home, 'state.json'))
  assert.equal(state.isCooling('L2-x', '2026-11-28'), false)
  state.markDereferenced('L2-x', '2026-11-20', 3)
  assert.equal(state.isCooling('L2-x', '2026-11-22'), true)
  assert.equal(state.isCooling('L2-x', '2026-11-30'), false, 'cooldown ends after 7 days')
  state.markDereferenced('L2-x', '2026-11-20', 3)
  state.markDereferenced('L2-x', '2026-11-20', 3)
  assert.equal(state.isFrozen('L2-x'), true)
  state.protect('L2-y', '2026-11-28', 30)
  assert.equal(state.isProtected('L2-y', '2026-12-01'), true)
  assert.equal(state.isProtected('L2-y', '2027-01-05'), false)
  assert.equal(addDays('2026-11-28', 2), '2026-11-30')
})

test('a dereferenced record stays forgotten during the cooldown', () => {
  const store = seed()
  applyOps(store, [{ op: 'add_l2', claim: '用户提到过一只狗叫豆豆' }], noop)
  const id = store.readL2().records.find((r) => r.claim.includes('豆豆')).id
  applyOps(store, [{ op: 'dereference_l2', id }], noop)
  assert.equal(store.readL2().records.find((r) => r.id === id).status, 'dereferenced')

  const again = applyOps(store, [{ op: 'add_l2', claim: '用户提到过一只狗叫豆豆' }], noop)
  assert.equal(again.added, 0, 'cooling blocks the automatic re-record')
  assert.equal(again.cooling, 1)
})

test('a protected record cannot be dereferenced automatically', () => {
  const store = seed()
  applyOps(store, [{ op: 'add_l2', claim: '用户希望被称呼为女娲娘娘' }], noop)
  const id = store.readL2().records.find((r) => r.claim.includes('女娲')).id
  store.state.protect(id, new Date().toISOString().slice(0, 10))
  const result = applyOps(store, [{ op: 'dereference_l2', id }], noop)
  assert.equal(result.dereferenced, 0)
  assert.equal(result.blocked, 1)
  assert.equal(store.readL2().records.find((r) => r.id === id).status, 'active')
})

test('three dereferences freeze the record', () => {
  const store = seed()
  applyOps(store, [{ op: 'add_l2', claim: '用户偶尔提到旧项目' }], noop)
  const id = store.readL2().records.find((r) => r.claim.includes('旧项目')).id
  const today = new Date().toISOString().slice(0, 10)
  for (let i = 0; i < 3; i += 1) store.state.markDereferenced(id, today, 3)
  assert.equal(store.state.isFrozen(id), true)
  const result = applyOps(store, [{ op: 'dereference_l2', id }], noop)
  assert.equal(result.blocked, 1)
  assert.equal(result.dereferenced, 0)
})

test('memory_remember restores a cooling record and protects it', async () => {
  const store = seed()
  applyOps(store, [{ op: 'add_l2', claim: '用户喜欢喝乌龙茶' }], noop)
  const id = store.readL2().records.find((r) => r.claim.includes('乌龙茶')).id
  applyOps(store, [{ op: 'dereference_l2', id }], noop)

  const registered = new Map()
  const ctx = { tools: { register: (definition) => registered.set(definition.name, definition) } }
  registerTools(ctx, store, { log: noop })
  const result = await registered.get('memory_remember').execute({ text: '用户喜欢喝乌龙茶' })
  assert.match(result, /protected until/)
  const record = store.readL2().records.find((r) => r.id === id)
  assert.equal(record.status, 'active')
  assert.equal(store.state.isProtected(id, new Date().toISOString().slice(0, 10)), true)
})
