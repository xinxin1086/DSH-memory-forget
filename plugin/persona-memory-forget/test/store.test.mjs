/**
 * M1 unit tests. They run with plain `node --test`; nothing here needs the
 * Harness, which is the point of putting storage behind small modules.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore, parseRules, parseBlocks, renderBlocks } from '../lib/store.js'
import { tokenize, recall, formatRecall } from '../lib/retrieve.js'
import { registerTools } from '../lib/tools.js'

const tempHome = () => mkdtempSync(join(tmpdir(), 'persona-memory-test-'))

const seedStore = () => {
  const home = tempHome()
  const store = createStore({ persona: 'test', home }).init()
  store.writeL2([
    { id: 'L2-a1', layer: 'L2', claim: '用户提到过一只狗，叫豆豆', status: 'active', fields: { claim: '用户提到过一只狗，叫豆豆', status: 'active', scope: '谁=用户', evidence: 'E1' } },
    { id: 'L2-a2', layer: 'L2', claim: '上周讨论过搬家时间', status: 'dereferenced', fields: { claim: '上周讨论过搬家时间', status: 'dereferenced' } },
  ])
  store.writeL1([
    { id: 'L1-b1', layer: 'L1', claim: '工作日晚上不要主动提议加班', status: 'active', fields: { claim: '工作日晚上不要主动提议加班', status: 'active', scope: '谁=小明;动作=加班' } },
  ])
  return { home, store }
}

test('init creates the persona layout and never overwrites records', () => {
  const home = tempHome()
  const store = createStore({ persona: 'p1', home }).init()
  for (const file of ['rules.md', 'persona.md', 'memory.md']) {
    assert.ok(existsSync(join(store.paths.root, file)), `${file} exists`)
  }
  writeFileSync(store.paths.memory, '# L2 记忆\n\n## L2-keep\n- claim: keep me\n- status: active\n', 'utf8')
  createStore({ persona: 'p1', home }).init()
  assert.match(readFileSync(store.paths.memory, 'utf8'), /keep me/)
})

test('rules parse into stable ids and fail closed on an unknown line', () => {
  const rules = parseRules('- [norm] 不替用户做不可逆决定\n- [aim] 为小明带来快乐\n')
  assert.equal(rules.length, 2)
  assert.equal(rules[0].tag, 'norm')
  assert.match(rules[0].id, /^L0-norm-[0-9a-f]{6}$/)
  assert.equal(rules[0].id, parseRules('- [norm] 不替用户做不可逆决定')[0].id, 'id is content-stable')
  assert.throws(() => parseRules('- 没有标签的一行'), /rules\.md:1/)
})

test('L0 read is fail-closed: a broken file yields an error and no rules', () => {
  const home = tempHome()
  const store = createStore({ persona: 'p2', home }).init()
  writeFileSync(store.paths.rules, '- [norm] 好规则\n- 坏规则\n', 'utf8')
  const result = store.readRules()
  assert.equal(result.rules.length, 0)
  assert.match(result.error, /rules\.md:2/)
})

test('block files round-trip through render and parse', () => {
  const records = [{ id: 'L2-x', layer: 'L2', fields: { claim: '有空格 的 内容', status: 'active' } }]
  const parsed = parseBlocks(renderBlocks(records, 't'), 'L2')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].fields.claim, '有空格 的 内容')
  assert.throws(() => parseBlocks('# t\n- orphan: 1\n', 'L2'), /field outside a record/)
})

test('writes are atomic and leave no temp files', () => {
  const { store } = seedStore()
  store.writeL2(store.readL2().records)
  const leftovers = readdirSync(store.paths.root).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

test('a held lock refuses the write instead of waiting', () => {
  const { store } = seedStore()
  writeFileSync(store.lockPath, '', 'utf8')
  assert.throws(() => store.writeL2([]), /busy/)
})

test('tokenize handles CJK bigrams and latin words', () => {
  const tokens = tokenize('豆豆 dog 搬家')
  assert.ok(tokens.includes('豆豆'))
  assert.ok(tokens.includes('搬家'))
  assert.ok(tokens.includes('dog'))
})

test('recall filters by state and returns summaries without raw fields', () => {
  const { store } = seedStore()
  const source = store.readAll()
  const active = recall(source, { query: '豆豆' })
  assert.equal(active.length, 1)
  assert.equal(active[0].id, 'L2-a1')
  assert.equal(active[0].status, 'active')
  assert.ok(!('fields' in active[0]))
  const forgotten = recall(source, { query: '搬家', states: ['dereferenced'] })
  assert.equal(forgotten.length, 1)
  assert.match(formatRecall(forgotten), /不是原文/)
})

test('an empty query returns active records and a miss explains the state filter', () => {
  const { store } = seedStore()
  const hits = recall(store.readAll(), {})
  assert.ok(hits.length >= 2)
  assert.match(formatRecall([], { query: '不存在的东西' }), /states=active/)
})

test('tools register and answer through a fake context', async () => {
  const home = tempHome()
  writeFileSync(join(home, 'unused'), '', 'utf8')
  const store = createStore({ persona: 'tools', home }).init()
  store.writeL2([{ id: 'L2-t1', layer: 'L2', claim: '用户喜欢西红柿炒鸡蛋', status: 'active', fields: { claim: '用户喜欢西红柿炒鸡蛋', status: 'active' } }])

  const registered = new Map()
  const ctx = { tools: { register: (definition) => registered.set(definition.name, definition) } }
  registerTools(ctx, store, { log: () => {} })
  assert.deepEqual([...registered.keys()].sort(), ['memory_recall', 'memory_remember', 'memory_status'])

  const recallTool = registered.get('memory_recall')
  const hit = await recallTool.execute({ query: '西红柿' })
  assert.match(hit, /L2-t1/)
  assert.match(hit, /不是原文/)

  const revealed = await recallTool.execute({ query: '西红柿', reveal: true })
  assert.match(revealed, /会随会话日志上行/)

  const status = await registered.get('memory_status').execute({})
  assert.match(status, /L1: 0 条/)
  assert.match(status, /L2: 1 条/)
})

test('status surfaces parse errors instead of hiding them', () => {
  const home = tempHome()
  const store = createStore({ persona: 'broken', home }).init()
  writeFileSync(store.paths.memory, '## L2-x\n- claim: 好\n- 坏行\n', 'utf8')
  const status = store.status()
  assert.equal(status.l2.count, 0)
  assert.match(status.l2.error, /memory\.md:3/)
})

