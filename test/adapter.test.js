import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { CursorAdapter, StreamTranslator, EventQueue } from '../lib/adapter.js'

/** 一轮典型的混合事件：思考 + 正文 + 工具调用 + 结束。 */
const EVENTS = [
  { type: 'thinking-delta', text: '想一下' },
  { type: 'text-delta', text: 'Hello' },
  { type: 'text-delta', text: ' world' },
  { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
  {
    type: 'turn-ended',
    usage: { inputTokens: 100, outputTokens: 2, cacheRead: 5, cacheWrite: 1, reasoningTokens: 3 },
  },
]

/** 把 translator 的完整输出喂给 DSH 自己的 BlockAssembler，验证契约成立。 */
function assemble(events) {
  const translator = new StreamTranslator()
  const chunks = [...translator.push(events), ...translator.close({ kind: 'stop' })]
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return { chunks, blocks: assembler.blocks() }
}

test('block-start 与 block-end 一一配对（BlockAssembler 不抛错）', () => {
  const { chunks, blocks } = assemble(EVENTS)
  const starts = chunks.filter((c) => c.type === 'block-start').map((c) => c.index)
  const ends = chunks.filter((c) => c.type === 'block-end').map((c) => c.index)
  assert.deepEqual(ends, starts, '每个 block-start 都必须有同索引的 block-end')
  assert.equal(blocks.length, starts.length)
})

test('assemble 出的块内容正确：reasoning / text / tool-call', () => {
  const { blocks } = assemble(EVENTS)
  assert.equal(blocks.find((b) => b.type === 'reasoning').text, '想一下')
  assert.equal(blocks.find((b) => b.type === 'text').text, 'Hello world')
  const tool = blocks.find((b) => b.type === 'tool-call')
  assert.equal(tool.id, 'call_1')
  assert.equal(tool.name, 'read_file')
  assert.equal(tool.arguments, '{"path":"a.ts"}')
})

test('finish.reason 是对象而非字符串', () => {
  const { chunks } = assemble(EVENTS)
  const finish = chunks.filter((c) => c.type === 'finish')
  assert.equal(finish.length, 1)
  assert.equal(typeof finish[0].reason, 'object')
  assert.equal(finish[0].reason.kind, 'stop')
})

test('usage 字段名对齐 TokenUsage', () => {
  const usage = new StreamTranslator().push(EVENTS).find((c) => c.type === 'usage').usage
  assert.equal(usage.inputTokens, 100)
  assert.equal(usage.outputTokens, 2)
  assert.equal(usage.cacheReadTokens, 5)
  assert.equal(usage.cacheWriteTokens, 1)
  assert.equal(usage.reasoningTokens, 3)
})

test('跨批次推送仍保持同一个 block（索引不漂移）', () => {
  const translator = new StreamTranslator()
  const first = translator.push([{ type: 'text-delta', text: 'A' }])
  const second = translator.push([{ type: 'text-delta', text: 'B' }])
  assert.equal(first.filter((c) => c.type === 'block-start').length, 1)
  assert.equal(second.filter((c) => c.type === 'block-start').length, 0, '第二批不应重复 block-start')
  const closes = translator.close({ kind: 'stop' }).filter((c) => c.type === 'block-end')
  assert.equal(closes[0].block.text, 'AB')
})

test('同一个工具 id 的多段参数累积到一个 block', () => {
  const translator = new StreamTranslator()
  const chunks = [
    ...translator.push([{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"a"' }]),
    ...translator.push([{ type: 'tool-call', id: 'c1', name: 'read', arguments: ':1}' }]),
    ...translator.close({ kind: 'stop' }),
  ]
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 1)
  assert.equal(chunks.find((c) => c.type === 'block-end').block.arguments, '{"a":1}')
})

test('没有事件时 close 只产出 finish，不产生悬空 block', () => {
  const chunks = new StreamTranslator().close({ kind: 'error' })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
})

test('EventQueue：push/next 顺序与关闭语义', async () => {
  const queue = new EventQueue()
  const got = []
  const consume = (async () => {
    for (;;) {
      const item = await queue.next()
      if (item === undefined) break
      got.push(item)
    }
  })()
  queue.push({ type: 'text-delta', text: 'x' })
  queue.close()
  await consume
  assert.equal(got.length, 1)
  assert.equal(got[0].text, 'x')
})

test('adapter.resolveModel 返回扁平 LlmResolvedModelInfo', async () => {
  const models = await import('../lib/models.js')
  models.__setCatalog(async () => [{
    id: 'claude-sonnet-5', display: 'Claude Sonnet 5', images: true, context: 272000,
    hidden: false, options: {}, order: [], variants: [], params: {}, aliases: [], slugs: [],
  }])
  const info = await new CursorAdapter().resolveModel('cursor', 'claude-sonnet-5')
  assert.equal(info.provider, 'cursor')
  assert.equal(info.id, 'claude-sonnet-5')
  assert.equal(info.name, 'Claude Sonnet 5')
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.deepEqual(info.context, { contextWindow: 272000 })
  assert.equal(info.info, undefined, '不能嵌套 info')
})

test('adapter.providerInfo 的 id 与注册路由一致', () => {
  const info = new CursorAdapter().providerInfo('cursor')
  assert.equal(info.id, 'cursor')
  assert.ok(typeof info.name === 'string' && info.name.length > 0)
})