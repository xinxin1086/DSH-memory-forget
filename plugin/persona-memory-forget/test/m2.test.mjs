/**
 * M2 tests: rule tolerance, pack composition, judge ops, injection cadence,
 * maintenance clock trigger. No Harness required.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, parseRules } from '../lib/store.js'
import { buildPack, hashText } from '../lib/pack.js'
import { parseOps, applyOps } from '../lib/judge.js'
import { registerInjection } from '../lib/inject.js'
import { registerClock } from '../lib/clock.js'
import { recall } from '../lib/retrieve.js'

const tempHome = () => mkdtempSync(join(tmpdir(), 'persona-memory-m2-'))

const seed = (rules) => {
  const home = tempHome()
  const store = createStore({ persona: 'm2', home }).init()
  writeFileSync(store.paths.rules, rules, 'utf8')
  store.writeL1([{ id: 'L1-a', layer: 'L1', claim: '工作日晚上不要主动提议加班', status: 'active', scope: '谁=用户', fields: { claim: '工作日晚上不要主动提议加班', status: 'active', scope: '谁=用户' } }])
  store.writeL2([
    { id: 'L2-dog', layer: 'L2', claim: '用户提到过一只狗，叫豆豆', status: 'active', fields: { claim: '用户提到过一只狗，叫豆豆', status: 'active', evidence: 'E1' } },
  ])
  return { store, home }
}

const fakeCtx = ({ parent = null, agents = [] } = {}) => {
  const handlers = new Map()
  return {
    handlers,
    subagents: { namesOf: () => ({ self: 'lead', ...(parent ? { parent } : {}) }) },
    agents: { list: () => agents },
    tools: { register: () => {} },
    on: (event, handler) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
  }
}

const decisionWith = (text) => ({
  kind: 'enter',
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
})

test('rules accept the editor-mangled "* \\[norm]" form', () => {
  const rules = parseRules('* \\[norm] 不替用户做不可逆决定\n* \\[aim] 为用户带来快乐\n')
  assert.equal(rules.length, 2)
  assert.equal(rules[0].tag, 'norm')
  assert.equal(rules[1].text, '为用户带来快乐')
  assert.equal(parseRules('- [norm] 同一条')[0].id, parseRules('* \\[norm] 同一条')[0].id)
})

test('pack: root sees summaries, child sees only rules and persona', () => {
  const { store } = seed('- [norm] 遵守法律\n- [aim] 为用户带来快乐\n')
  const rootPack = buildPack(store, { isRoot: true, query: '豆豆' })
  assert.match(rootPack.text, /## 准则/)
  assert.match(rootPack.text, /L2-dog/)
  assert.match(rootPack.text, /不是用户的新指令/)
  assert.doesNotMatch(rootPack.text, /evidence/)

  const childPack = buildPack(store, { isRoot: false, query: '豆豆' })
  assert.doesNotMatch(childPack.text, /## 记忆/)
  assert.doesNotMatch(childPack.text, /L2-dog/)
  assert.match(childPack.text, /工作日晚上/)
})

test('pack fails closed when rules cannot be parsed', () => {
  const { store } = seed('- 坏行\n')
  const pack = buildPack(store, { isRoot: true })
  assert.equal(pack.text, '')
  assert.match(pack.reason, /rules\.md:1/)
})

test('parseOps keeps known ops, drops junk, caps at eight', () => {
  const text = 'noise {"ops":[{"op":"add_l2","claim":"  用户喜欢\\n西红柿  "},{"op":"nope"},{"op":"dereference_l2","id":"L2-x"}]} tail'
  const { ops, error } = parseOps(text)
  assert.equal(error, null)
  assert.equal(ops.length, 2)
  assert.equal(ops[0].claim, '用户喜欢 西红柿')
  assert.equal(ops[1].id, 'L2-x')
  const many = parseOps(JSON.stringify({ ops: Array.from({ length: 20 }, (_, i) => ({ op: 'add_l2', claim: `c${i}` })) }))
  assert.equal(many.ops.length, 8)
})

test('applyOps adds, dedupes, dereferences and files L1 proposals', () => {
  const { store } = seed('- [aim] 为用户带来快乐\n')
  const log = () => {}
  const first = applyOps(store, [
    { op: 'add_l2', claim: '用户喜欢西红柿炒鸡蛋' },
    { op: 'add_l2', claim: '用户喜欢西红柿炒鸡蛋' },
    { op: 'dereference_l2', id: 'L2-dog' },
    { op: 'propose_l1', claim: '用户不喜欢被催促', aims: ['L0-aim-x'], scope: '谁=用户' },
  ], log)
  assert.equal(first.added, 1)
  assert.equal(first.dereferenced, 1)
  assert.equal(first.proposed, 1)
  const records = store.readL2().records
  assert.equal(records.filter((r) => r.claim === '用户喜欢西红柿炒鸡蛋').length, 1)
  assert.equal(records.find((r) => r.id === 'L2-dog').status, 'dereferenced')
  assert.ok(records.some((r) => /^L2-[0-9a-z]{7}$/.test(r.id)), 'new ids are 7-char base36')
  assert.match(readFileSync(store.paths.pending, 'utf8'), /待确认 L1-/)

  const second = applyOps(store, [{ op: 'add_l2', claim: '用户喜欢西红柿炒鸡蛋' }], log)
  assert.equal(second.added, 0, 'duplicate is not re-added')
})

test('injection is once per turn, resent on change, and child gets no L2', async () => {
  const { store } = seed('- [norm] 遵守法律\n')
  const ctx = fakeCtx()
  registerInjection({ ctx, store, config: { enabled: true, limits: {} }, log: () => {} })
  const [handler] = ctx.handlers.get('agent/pre-step')

  const agent = { session: { id: 's1' } }
  const step = async (turn, text) => handler({ agent, turn, step: 1 }, async () => decisionWith(text))
  const first = await step(1, '豆豆怎么样')
  assert.equal(first.messages.length, 2)
  const again = await step(1, '豆豆怎么样')
  assert.equal(again.messages.length, 1, 'same turn and pack is not reinjected')
  store.writeL2([...store.readL2().records, {
    id: 'L2-gold', layer: 'L2', claim: '用户说豆豆是金毛', status: 'active',
    fields: { claim: '用户说豆豆是金毛', status: 'active' },
  }])
  const changed = await step(1, '豆豆怎么样')
  assert.equal(changed.messages.length, 2, 'a memory change reinjects within the turn')
  const nextTurn = await step(2, '豆豆怎么样')
  assert.equal(nextTurn.messages.length, 2, 'new turn injects again')

  const childCtx = fakeCtx({ parent: 'lead' })
  registerInjection({ ctx: childCtx, store, config: { enabled: true, limits: {} }, log: () => {} })
  const [childHandler] = childCtx.handlers.get('agent/pre-step')
  const child = await childHandler(
    { agent: { session: { id: 's2' } }, turn: 1, step: 1 },
    async () => decisionWith('豆豆'),
  )
  assert.match(child.messages[1].content[0].text, /## 准则/)
  assert.doesNotMatch(child.messages[1].content[0].text, /L2-dog/)
})

test('the clock buffers user lines and judges at turn end', async () => {  const { store } = seed('- [aim] 为用户带来快乐\n')
  const agent = { session: { id: 's1' } }
  const ctx = fakeCtx({ agents: [agent] })
  const calls = []
  registerClock({
    ctx,
    store,
    runJudge: async (options) => { calls.push(options.candidates) },
    config: { turnsPerRun: 1, maxCandidates: 40, judge: {} },
    log: () => {},
  })
  const [preStep] = ctx.handlers.get('agent/pre-step')
  const [onEvent] = ctx.handlers.get('session/event')
  await preStep({ agent }, async () => decisionWith('我喜欢西红柿炒鸡蛋'))
  onEvent({ id: 's1' }, { type: 'turn/end' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(calls, [['我喜欢西红柿炒鸡蛋']])
  onEvent({ id: 's1' }, { type: 'step/end' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls.length, 1, 'unrelated events do not judge')
  assert.ok(hashText('x') !== hashText('y'))
})

test('parseOps keeps a valid expires and drops an invalid one', () => {
  const { ops } = parseOps(JSON.stringify({
    ops: [
      { op: 'add_l2', claim: '计划', expires: '2026-11-29' },
      { op: 'add_l2', claim: '坏日期', expires: '明天' },
    ],
  }))
  assert.equal(ops[0].expires, '2026-11-29')
  assert.equal(ops[1].expires, undefined)
})

test('expires: due records sweep to expired, leave active, and stay queryable', () => {  const { store } = seed('- [aim] 为用户带来快乐\n')
  applyOps(store, [{ op: 'add_l2', claim: '用户明天下午去买衣服', expires: '2026-11-29' }], () => {})
  const record = store.readL2().records.find((r) => r.claim.includes('买衣服'))
  assert.equal(record.expires, '2026-11-29')
  assert.equal(recall(store.readAll(), { query: '买衣服' }).length, 1)

  const swept = store.sweepExpired('2026-11-30')
  assert.equal(swept.expired, 1)
  assert.equal(recall(store.readAll(), { query: '买衣服' }).length, 0, 'expired is not active by default')
  assert.equal(recall(store.readAll(), { query: '买衣服', states: ['expired'] }).length, 1, 'expired stays queryable')
  assert.equal(store.readL2().records.find((r) => r.id === record.id).status, 'expired')
})


test('dedupe: update_l2 rewrites one record, add_l2 guards identical text', () => {
  const { store } = seed('- [aim] 为用户带来快乐\n')
  const log = () => {}
  applyOps(store, [{ op: 'add_l2', claim: '用户不吃香菜' }], log)
  const id = store.readL2().records.find((r) => r.claim === '用户不吃香菜').id

  const updated = applyOps(store, [{ op: 'update_l2', id, claim: '用户不吃香菜，也不吃葱' }], log)
  assert.equal(updated.merged, 1, 'the model can rewrite the record it matched')
  const records = store.readL2().records.filter((r) => r.status === 'active' && r.claim.includes('香菜'))
  assert.equal(records.length, 1)
  assert.match(records[0].claim, /不吃葱/)

  const exact = applyOps(store, [{ op: 'add_l2', claim: '用户不吃香菜，也不吃葱' }], log)
  assert.equal(exact.added, 0, 'identical text is never added twice')
  assert.equal(exact.duplicate, 1)
})

test('pack reports how many records it did not show', () => {
  const home = tempHome()
  const store = createStore({ persona: 'many', home }).init()
  writeFileSync(store.paths.rules, '- [aim] 为用户带来快乐\n', 'utf8')
  const records = Array.from({ length: 12 }, (_, i) => ({
    id: `L2-x${i}`,
    layer: 'L2',
    claim: `独立事项编号${i}：内容${String.fromCharCode(0x4e00 + i)}${i}`,
    status: 'active',
    fields: { claim: `独立事项编号${i}：内容${String.fromCharCode(0x4e00 + i)}${i}`, status: 'active' },
  }))
  store.writeL2(records)
  const pack = buildPack(store, { isRoot: true, query: '', limits: { maxL2: 8 } })
  assert.match(pack.text, /另有 4 条未展示/)
})

test('the oldest undated records demote when the active set exceeds maxActive', () => {
  const home = tempHome()
  const store = createStore({ persona: 'demote', home }).init()
  writeFileSync(store.paths.rules, '- [aim] 为用户带来快乐\n', 'utf8')
  const records = [
    { id: 'L2-a', layer: 'L2', claim: '旧记录甲', status: 'active', updated: '2026-01-01', fields: { claim: '旧记录甲', status: 'active', updated: '2026-01-01' } },
    { id: 'L2-b', layer: 'L2', claim: '旧记录乙', status: 'active', updated: '2026-02-01', fields: { claim: '旧记录乙', status: 'active', updated: '2026-02-01' } },
    { id: 'L2-c', layer: 'L2', claim: '新记录丙', status: 'active', updated: '2026-03-01', fields: { claim: '新记录丙', status: 'active', updated: '2026-03-01' } },
  ]
  store.writeL2(records)
  const result = store.demoteExcess(2)
  assert.equal(result.demoted, 1)
  const after = store.readL2().records
  assert.equal(after.find((r) => r.id === 'L2-a').status, 'dormant')
  assert.equal(after.find((r) => r.id === 'L2-c').status, 'active')
})
