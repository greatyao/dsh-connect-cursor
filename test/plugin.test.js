import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../lib/index.js'

/** 构造一个 mock 的 DSH ctx，记录注册调用。 */
function mockCtx() {
  const calls = { adapters: [], configurable: [], discovery: [], logs: [] }
  return {
    calls,
    logger: {
      info: (m) => calls.logs.push(['info', m]),
      warn: (m) => calls.logs.push(['warn', m]),
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        calls.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders: (entries) => {
        calls.configurable.push(...entries)
        return () => {}
      },
      registerModelDiscovery: (ns, fn) => {
        calls.discovery.push({ ns, fn })
        return () => {}
      },
    },
  }
}

test('插件导出 name / inject / apply', () => {
  assert.equal(plugin.name, 'dsh-connect-cursor')
  assert.deepEqual(plugin.inject, ['llm'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 注册 adapter + configurable provider + model discovery', async () => {
  const ctx = mockCtx()
  const dispose = await plugin.apply(ctx)
  assert.equal(ctx.calls.adapters.length, 1)
  assert.deepEqual(ctx.calls.adapters[0].providers, ['cursor'])
  assert.equal(typeof ctx.calls.adapters[0].adapter.stream, 'function')
  assert.equal(ctx.calls.configurable.length, 1)
  assert.equal(ctx.calls.configurable[0].provider, 'cursor')
  assert.equal(ctx.calls.configurable[0].displayName, 'Cursor')
  assert.equal(ctx.calls.configurable[0].settingsNs, 'cursor')
  assert.equal(ctx.calls.discovery.length, 1)
  assert.equal(ctx.calls.discovery[0].ns, 'cursor')
  assert.equal(typeof dispose, 'function')
})

test('model discovery 返回模型清单（注入合成目录）', async () => {
  const { __setCatalog } = await import('../lib/models.js')
  __setCatalog(async () => [
    { id: 'claude-sonnet-5', display: 'Claude Sonnet 5', images: true, context: 272000, hidden: false },
    { id: 'secret-model', display: 'Secret', images: false, context: 0, hidden: true },
  ])
  const ctx = mockCtx()
  await plugin.apply(ctx)
  const discovery = ctx.calls.discovery[0].fn
  const models = await discovery({}, {})
  assert.equal(models.length, 1) // hidden 被过滤
  assert.equal(models[0].id, 'claude-sonnet-5')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.equal(models[0].contextWindow, 272000)
})
