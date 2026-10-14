import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __setCatalog, resolveModel } from '../lib/models.js'

/** 注入合成目录，避免网络请求。 */
function withCatalog(modelsList, fn) {
  __setCatalog(async () => modelsList)
  return fn()
}

const SONNET = {
  id: 'claude-sonnet-5', display: 'Claude Sonnet 5',
  options: { thinking: ['true', 'false'], effort: ['low', 'high'] },
  order: ['thinking', 'effort'],
  variants: [
    { params: { thinking: 'true', effort: 'high' }, id: 'claude-sonnet-5-thinking-high', spec: 'claude-sonnet-5[thinking=true,effort=high]', default: true },
  ],
  params: { thinking: 'true', effort: 'high' },
  aliases: [], slugs: ['claude-sonnet-5-thinking-high'],
  thinking: true, images: true, context: 272000, hidden: false,
}

test('resolveModel: 直接命中基础模型 id', async () => {
  await withCatalog([SONNET], async () => {
    const { modelId, baseId, params } = await resolveModel('claude-sonnet-5')
    assert.equal(baseId, 'claude-sonnet-5')
    // 服务端只认默认 variant 的 slug，modelId 必须是它
    assert.equal(modelId, 'claude-sonnet-5-thinking-high')
    assert.equal(params.thinking, 'true')
  })
})

test('resolveModel: 别名映射到目标模型', async () => {
  const withAlias = { ...SONNET, aliases: ['claude-3-5-sonnet'] }
  await withCatalog([withAlias], async () => {
    const { baseId } = await resolveModel('claude-3-5-sonnet')
    assert.equal(baseId, 'claude-sonnet-5')
  })
})

test('resolveModel: 未知模型回退到默认（catalog 里有的那个）', async () => {
  await withCatalog([SONNET], async () => {
    // fallback 传 catalog 里存在的模型，断言回退到它。
    const { baseId } = await resolveModel('totally-unknown-model-xyz', 'claude-sonnet-5')
    assert.equal(baseId, 'claude-sonnet-5')
  })
})

test('resolveModel: variant slug 解析出参数', async () => {
  await withCatalog([SONNET], async () => {
    const { modelId, baseId, params } = await resolveModel('claude-sonnet-5-thinking-high')
    assert.equal(baseId, 'claude-sonnet-5')
    assert.equal(modelId, 'claude-sonnet-5-thinking-high')
    assert.equal(params.effort, 'high')
  })
})

test('resolveModel: 显式参数语法 model[thinking=false]', async () => {
  await withCatalog([SONNET], async () => {
    const { baseId, params } = await resolveModel('claude-sonnet-5[thinking=false]')
    assert.equal(baseId, 'claude-sonnet-5')
    assert.equal(params.thinking, 'false')
  })
})
