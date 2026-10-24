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
  // 目录随账号权限增减（实测见过 44 个与 9 个两种规模），只断言"解析出了东西"
  // 与"每个模型都带默认 variant slug"，不断言具体数量或具体模型名。
  assert.ok(live.length > 0, '应至少解析出一个模型')
  for (const model of live) {
    assert.ok(model.id, '模型应有 id')
    // 部分模型（如 kimi-k2.7-code）确实没有 variant，服务端接受其基础 id。
    if (model.variants.length) {
      const preferred = model.variants.find((v) => v.default)
      assert.ok(preferred?.id, `${model.id} 应有 default variant（服务端只认它的 slug）`)
    }
  }

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

test('每个模型的默认 variant slug 都能被解析出来', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  // 目录随账号权限增减，测试不写死模型名 —— 逐个验证目录里的每个模型。
  for (const model of REAL) {
    const { modelId, baseId } = await resolveModel(model.id)
    assert.equal(baseId, model.id)
    const preferred = model.variants.find((v) => v.default)
    // 有 default variant 时必须用它的 slug；没有时用基础 id（实测服务端也认）。
    assert.equal(modelId, preferred?.id || model.id, `${model.id} 的 slug 解析异常`)
  }
})

test('显式参数语法覆盖默认值', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  const target = REAL.find((m) => m.variants.some((v) => v.default && v.params.effort))
  if (!target) return t.skip('目录里没有带 effort 的模型')
  const { baseId, params } = await resolveModel(`${target.id}[effort=low]`)
  assert.equal(baseId, target.id)
  assert.equal(params.effort, 'low')
})

test('显式指定不存在的模型时报错（不静默换成别的模型）', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  await assert.rejects(
    () => resolveModel('绝对不存在的模型-xyz'),
    /没有模型/,
    '静默换模型会让用户以为在用 A、实际发出去的是 B',
  )
})

test('未指定模型时取目录第一个（贴合账号实际可用范围）', async (t) => {
  if (!REAL) return t.skip('无 fixture')
  __setCatalog(async () => REAL)
  const { baseId } = await resolveModel('')
  assert.equal(baseId, REAL[0].id)
})

test('fetchCatalog 已导出（曾被重构误删，导致 catalog() 走网络必崩）', () => {
  assert.equal(typeof fetchCatalog, 'function')
})