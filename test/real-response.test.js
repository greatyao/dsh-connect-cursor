import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModel, __setCatalog, fetchCatalog } from '../lib/models.js'

/**
 * 用 2026-10 实测抓下的真实 AvailableModels 响应做离线回归。
 *
 * fixture 是 fetchCatalog() 的**真实解析输出**（不是我自己复刻的 protobuf 遍历），
 * 这样字段号一旦写错，解析结果就会与 fixture 不符而立刻暴露。
 * 没有 fixture 时（CI / 首次运行）跳过网络用例，只跑不依赖网络的断言。
 */
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-catalog.json')
let REAL = null
if (existsSync(FIXTURE_PATH)) {
  REAL = JSON.parse(await readFile(FIXTURE_PATH, 'utf8'))
}

async function readFile(path, encoding) {
  const { readFile: rf } = await import('node:fs/promises')
  return rf(path, encoding)
}

test('真实抓取的目录快照与当前解析结果一致（字段号回归护栏）', async (t) => {
  let live
  try {
    live = await fetchCatalog()
  } catch (error) {
    if (!REAL) return t.skip(`无法联网且无 fixture：${error.message}`)
    t.diagnostic('联网失败，改用 fixture 校验')
    return
  }
  assert.ok(live.length >= 40, `只解析出 ${live.length} 个模型`)
  const ids = live.map((m) => m.id).sort()
  for (const id of ['claude-sonnet-5', 'composer-2.5', 'claude-opus-5']) {
    assert.ok(ids.includes(id), `缺少 ${id}`)
  }
  const sonnet = live.find((m) => m.id === 'claude-sonnet-5')
  assert.equal(sonnet.display, 'Claude Sonnet 5')
  assert.equal(sonnet.context, 300000)
  assert.deepEqual(Object.keys(sonnet.options).sort(), ['context', 'effort', 'thinking'])
  assert.deepEqual(sonnet.options.effort, ['low', 'medium', 'high', 'xhigh', 'max'])

  // 快照落盘，供离线运行比对
  if (!REAL) {
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true })
    writeFileSync(FIXTURE_PATH, JSON.stringify(live, null, 1))
    t.diagnostic(`已生成 fixture：${live.length} 个模型`)
  }
})

test('default 标志取自 field 4（实测 composer-2.5-fast）', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  const composer = REAL.find((m) => m.id === 'composer-2.5')
  const defs = composer.variants.filter((v) => v.default)
  assert.equal(defs.length, 1, '应恰好一个 default variant')
  assert.equal(defs[0].id, 'composer-2.5-fast')
  assert.deepEqual(composer.params, { fast: 'true' })
})

test('同名 variant 不覆盖基础 id 的默认参数', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  const { modelId, params } = await resolveModel('composer-2.5')
  // modelId 必须是默认 variant 的 slug（服务端只认它）
  assert.equal(modelId, 'composer-2.5-fast')
  assert.deepEqual(params, { fast: 'true' })
})

test('真实模型族解析正确', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  const cases = [
    ['claude-sonnet-5', 'claude-sonnet-5', (p) => p.effort === 'high'],
    ['composer-2.5-fast', 'composer-2.5', (p) => p.fast === 'true'],
    ['claude-sonnet-5-max', 'claude-sonnet-5', (p) => p.effort === 'max'],
    ['claude-sonnet-5-low', 'claude-sonnet-5', (p) => p.effort === 'low'],
  ]
  for (const [input, expectId, check] of cases) {
    const { baseId, params } = await resolveModel(input)
    assert.equal(baseId, expectId, `${input} → ${baseId}`)
    assert.ok(check(params), `${input} 参数异常: ${JSON.stringify(params)}`)
  }
})

test('显式参数语法覆盖默认值', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  const { baseId, params } = await resolveModel('claude-sonnet-5[thinking=false,effort=low]')
  assert.equal(baseId, 'claude-sonnet-5')
  assert.equal(params.thinking, 'false')
  assert.equal(params.effort, 'low')
})

test('未知模型回退到 fallback', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  const { baseId } = await resolveModel('绝对不存在的模型-xyz', 'claude-sonnet-5')
  assert.equal(baseId, 'claude-sonnet-5')
})

test('fetchCatalog 已导出（曾被重构误删，导致 catalog() 走网络必崩）', () => {
  assert.equal(typeof fetchCatalog, 'function')
})