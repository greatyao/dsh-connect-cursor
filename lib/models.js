/**
 * Cursor 模型目录：账号可用模型清单 + 任意写法 → (基础模型 id, 参数) 的解析。
 *
 * 目录来自 CLI 模型选择器用的同一个 unary Connect 调用：
 *   POST https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels
 *   content-type: application/proto（unary，无流式帧）
 *
 * 参考：cursor2api（MIT）的 models.py，字段号与解析行为对齐。
 *
 * @module dsh-connect-cursor/models
 */

import { API_BASE, resolveCredential } from './auth.js'
import { getAll, get, getVar, msg } from './pb.js'

const RPC = `${API_BASE}/aiserver.v1.AiService/AvailableModels`
/** 客户端版本门：过期版本会被上游以误导性的错误拒绝，故可配置。 */
export const CLIENT_VERSION = process.env.CURSOR_CLI_VERSION || 'cli-2026.08.11-e8db854'
const TTL_MS = 15 * 60_000

/**
 * 兜底目录：网络不可用或凭据失效时用。
 * 取自 2026-10 实测的 AvailableModels 响应（44 个模型中的代表项），
 * 参数取该模型 variants 里的默认组合。
 */
const FALLBACK = [
  ['claude-fable-5', { thinking: 'true', effort: 'high', context: '300k' }],
  ['claude-opus-5', { thinking: 'true', effort: 'high', context: '300k' }],
  ['claude-sonnet-5', { thinking: 'true', effort: 'high', context: '300k' }],
  ['claude-haiku-4-5', { thinking: 'true', context: '200k' }],
  ['composer-2.5', { fast: 'true' }],
  ['grok-4.7', { reasoning_effort: 'high', fast: 'false', context: '256k' }],
  ['gpt-5.6-sol', { reasoning_effort: 'high', context: '272k' }],
  ['gemini-4-argon', { context: '1000k' }],
  ['kimi-k3', { context: '1048576' }],
]

/** 其他厂商 API 名称 → Cursor 模型，使既有客户端写法可用。 */
const ALIASES = {
  'claude-opus-4-1': 'claude-opus-5', 'claude-opus-4': 'claude-opus-5',
  'claude-3-opus': 'claude-opus-5',
  'claude-3-7-sonnet': 'claude-sonnet-5', 'claude-3-5-sonnet': 'claude-sonnet-5',
  'claude-3-5-haiku': 'claude-haiku-4-5', 'claude-3-haiku': 'claude-haiku-4-5',
  'gpt-5.6': 'gpt-5.6-sol', 'gpt-5': 'gpt-5.5', 'gpt-4.1': 'gpt-5.5',
  'gpt-4o-mini': 'gpt-5-mini', 'gpt-4o': 'gpt-5.5', 'o3': 'gpt-5.3-codex',
  'grok': 'grok-4.6', 'gemini-pro': 'gemini-3.1-pro', 'kimi': 'kimi-k3',
}

/** 单个参数定义的选项值（按展示顺序）。 */
function paramValues(blob) {
  const out = []
  for (const field of [1, 2]) {
    for (const group of getAll(blob, field)) {
      for (const opt of getAll(group, 1)) {
        const val = get(opt, 1)
        if (val !== undefined) out.push(val.toString('utf8'))
      }
    }
  }
  return out
}

/**
 * 解析一个 Variant。
 *
 * 实测字段：f1=repeated{1:key,2:value} 参数，f4=标记默认（实测 composer-2.5-fast），
 * f9=spec（`composer-2.5[fast=true]`），f11=slug（`composer-2.5-fast`）。
 */
function variant(blob) {
  const params = {}
  for (const p of getAll(blob, 1)) {
    const key = get(p, 1)
    const val = get(p, 2)
    if (key !== undefined) params[key.toString('utf8')] = (val || Buffer.alloc(0)).toString('utf8')
  }
  return {
    params,
    id: (get(blob, 11) || Buffer.alloc(0)).toString('utf8'),
    spec: (get(blob, 9) || Buffer.alloc(0)).toString('utf8'),
    default: Boolean(getVar(blob, 4)),
  }
}

/** 未指定 variant 时发送的默认参数。 */
function defaults(name, options, variants) {
  for (const v of variants) if (v.default) return { ...v.params }
  for (const [base, params] of FALLBACK) if (base === name) return { ...params }
  const out = {}
  for (const [pid, values] of Object.entries(options)) {
    if (!values.length) continue
    if (pid === 'thinking') out[pid] = values.includes('true') ? 'true' : values[0]
    else if (pid === 'effort' || pid === 'reasoning') out[pid] = values.includes('high') ? 'high' : values[values.length - 1]
    else out[pid] = values[0]
  }
  return out
}

/** 解析一个 AvailableModel。 */
function model(blob) {
  const name = (get(blob, 1) || Buffer.alloc(0)).toString('utf8')
  const options = {}
  const order = []
  for (const pdef of getAll(blob, 29)) {
    const pid = (get(pdef, 1) || Buffer.alloc(0)).toString('utf8')
    if (!pid) continue
    order.push(pid)
    options[pid] = paramValues(get(pdef, 4) || Buffer.alloc(0))
  }
  const variants = getAll(blob, 30).map(variant).filter((v) => Object.keys(v.params).length)
  return {
    id: name,
    display: (get(blob, 17) || Buffer.alloc(0)).toString('utf8') || name,
    options,
    order,
    variants,
    params: defaults(name, options, variants),
    aliases: getAll(blob, 37).map((x) => x.toString('utf8')),
    slugs: getAll(blob, 36).map((x) => x.toString('utf8')),
    thinking: Boolean(getVar(blob, 9)),
    images: Boolean(getVar(blob, 10)),
    context: getVar(blob, 15) || 0,
    hidden: Boolean(getVar(blob, 35)),
  }
}

/** 兜底目录（离线 / 凭据失效时）。 */
function fallbackCatalog() {
  return FALLBACK.map(([name, params]) => ({
    id: name, display: name, options: {}, order: [], variants: [],
    params: { ...params }, aliases: [], slugs: [],
    thinking: 'thinking' in params, images: true, context: 0, hidden: false,
  }))
}

/**
 * 拉取 AvailableModels（不走缓存）。失败抛出。
 *
 * 实测：响应是明文 protobuf，模型列表在 field 2（repeated），单模型约 5KB。
 * @returns {Promise<Array<object>>}
 */
export async function fetchCatalog() {
  const credential = await resolveCredential()
  const response = await fetch(RPC, {
    method: 'POST',
    headers: {
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
      authorization: `Bearer ${credential.accessToken}`,
      'user-agent': 'connect-es/1.6.1',
      'x-cursor-client-type': 'cli',
      'x-cursor-client-version': CLIENT_VERSION,
    },
    body: msg({ 2: true, 5: true, 7: true }),
  })
  if (!response.ok) {
    throw new Error(`AvailableModels HTTP ${response.status} ${response.statusText}`)
  }
  const raw = Buffer.from(await response.arrayBuffer())
  const models = getAll(raw, 2).map(model).filter((m) => m.id && m.id !== 'default')
  if (!models.length) throw new Error('AvailableModels 返回空目录')
  return models
}

let cache = { at: 0, models: [] }
/** 当前目录函数（可注入，便于测试）；默认走网络。 */
let catalogFn = defaultCatalog

/** 注入目录实现（测试用）。 */
export function __setCatalog(fn) {
  catalogFn = fn
  cache = { at: 0, models: [] }
}

/** 默认目录实现：网络拉取 + 缓存 + 兜底。 */
async function defaultCatalog() {
  const now = Date.now()
  if (cache.models.length && now - cache.at < TTL_MS) return cache.models
  try {
    const models = await fetchCatalog()
    cache = { at: now, models }
  } catch {
    if (cache.models.length) return cache.models
    cache = { at: now, models: fallbackCatalog() }
  }
  return cache.models
}

/** 缓存目录；RPC 失败时回退到内置清单。 */
export async function catalog(refresh = false) {
  if (refresh) {
    const models = await fetchCatalog().catch(() => null)
    if (models) {
      cache = { at: Date.now(), models }
      return models
    }
  }
  return catalogFn()
}

/** 本代理接受的全部模型 id（基础模型优先）。 */
export async function catalogIds() {
  const out = []
  const seen = new Set()
  for (const m of await catalog()) {
    for (const name of [m.id, ...m.variants.map((v) => v.id), ...m.slugs, ...m.aliases]) {
      if (name && !seen.has(name)) {
        seen.add(name)
        out.push(name)
      }
    }
  }
  return out
}

/**
 * name → (基础模型, 参数) 的全写法索引。
 *
 * 写入顺序即优先级：基础 id 必须在最后写，否则同名 variant
 * （实测 composer-2.5 的 fast=false variant 就叫 composer-2.5）会覆盖基础 id 的默认参数。
 */
function index(models) {
  const table = new Map()
  const put = (name, value) => {
    if (name) table.set(name.toLowerCase(), value)
  }
  for (const m of models) {
    for (const alias of m.aliases) put(alias, [m.id, m.params])
    for (const slug of m.slugs) put(slug, [m.id, m.params])
    for (const v of m.variants) {
      for (const name of [v.id, v.spec]) put(name, [m.id, v.params])
    }
    put(m.id, [m.id, m.params])
  }
  return table
}

/** 把 "<base>-<opt>-<opt>" 拆成基础模型 + 参数值。 */
function fromTokens(name, table, models) {
  const parts = name.split('-')
  for (let cut = parts.length - 1; cut > 0; cut -= 1) {
    const base = parts.slice(0, cut).join('-')
    const hit = table.get(base)
    if (!hit) continue
    const model = models.find((m) => m.id === hit[0])
    if (!model) continue
    const params = { ...hit[1] }
    for (const tok of parts.slice(cut)) {
      if (tok === 'thinking' || tok === 'think') params.thinking = 'true'
      else if (tok === 'nothinking' || tok === 'nonthinking') params.thinking = 'false'
      else if (tok === 'fast' || tok === 'max-mode') params.fast = 'true'
      else {
        const found = Object.entries(model.options).find(([, values]) => values.includes(tok))
        if (!found) return null
        params[found[0]] = tok
      }
    }
    return [model.id, params]
  }
  return null
}

/** 单个写法解析。 */
function resolveOne(name, table, models) {
  if (!name) return null
  const low = name.toLowerCase()
  if (table.has(low)) {
    const [base, params] = table.get(low)
    return [base, { ...params }]
  }
  if (low.includes('[') && low.endsWith(']')) {
    const head = low.slice(0, low.indexOf('['))
    const tail = low.slice(low.indexOf('[') + 1, -1)
    const got = resolveOne(head, table, models)
    if (got) {
      const [base, params] = got
      for (const pair of tail.split(',')) {
        const eq = pair.indexOf('=')
        if (eq > 0) params[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
      }
      return [base, params]
    }
  }
  for (const suffix of ['-latest', '-preview']) {
    if (low.endsWith(suffix)) return resolveOne(low.slice(0, -suffix.length), table, models)
  }
  if (low.length > 9 && /\d$/.test(low.slice(-1)) && low.slice(-9, -8) === '-') {
    return resolveOne(low.slice(0, -9), table, models)
  }
  const tokens = fromTokens(low, table, models)
  if (tokens) return tokens
  for (const [prefix, target] of Object.entries(ALIASES)) {
    if (low.startsWith(prefix)) {
      const hit = table.get(target)
      if (hit) return [hit[0], { ...hit[1] }]
    }
  }
  return null
}

/**
 * 任意模型写法 → 运行时所需的模型标识。
 *
 * 实测（2026-10）：Run 请求的 model_details.model_id 只接受**默认 variant 的 slug**
 * （如 claude-sonnet-5-thinking-high）；直接用基础 id 会被服务端拒为
 * ERROR_BAD_MODEL_NAME，所以这里额外解析出 slug。
 *
 * @param {string} name
 * @param {string} [fallback='claude-fable-5']
 * @returns {Promise<{modelId: string, baseId: string, display: string, params: Record<string,string>}>}
 */
export async function resolveModel(name, fallback = 'claude-fable-5') {
  const models = await catalog()
  const table = index(models)
  let hit = null
  for (const candidate of [name || fallback, fallback]) {
    hit = resolveOne((candidate || '').trim(), table, models)
    if (hit) break
  }
  const [baseId, params] = hit || [fallback, {}]
  const model = models.find((m) => m.id === baseId)
  const slug = defaultVariantSlug(model) || baseId
  return {
    modelId: slug,
    baseId,
    display: model?.display || slug,
    params: { ...(model?.params || {}), ...params },
  }
}

/** 模型的默认 variant slug —— 服务端只认它。 */
function defaultVariantSlug(model) {
  if (!model) return null
  const preferred = model.variants.find((v) => v.default)
  return preferred?.id || model.variants[0]?.id || null
}
