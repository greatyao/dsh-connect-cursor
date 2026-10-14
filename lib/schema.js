/**
 * 从 Cursor 桌面应用 bundle 提取 agent.v1 protobuf schema，转成 protobufjs 的 JSON 描述。
 *
 * Cursor 把 schema 以 protobuf-es 的 makeMessageType("类型名", () => [{no:N,name:"...",...}])
 * 形式内联在 workbench.desktop.main.js 里；`no` 就是字段号，`opt:!0` 表示可选。
 * 这里把它解析成 { nested: {...} } 的 protobufjs JSON 描述，供 schema 驱动编码使用。
 *
 * 之所以走这条路：AgentRunRequest 有 8 个必填字段（其中 request_context 有 50+ 字段），
 * 靠猜字段号试了 8 轮都差一点；用权威 schema 编码才不会错。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Cursor 桌面端 bundle 路径候选（按平台）。
 *
 * bundle 相对 app 根的位置在三个平台一致（out/vs/workbench/workbench.desktop.main.js），
 * 差别只在 app 根本身：macOS 在 .app 包内，Windows 是 install 目录，Linux 同 Windows 布局。
 * CURSOR_WORKBENCH_BUNDLE 环境变量始终优先，用于非默认安装位置。
 */
function bundleCandidates() {
  const rel = join('out', 'vs', 'workbench', 'workbench.desktop.main.js')
  const out = []
  if (process.env.CURSOR_WORKBENCH_BUNDLE) out.push(process.env.CURSOR_WORKBENCH_BUNDLE)
  if (process.platform === 'darwin') {
    out.push('/Applications/Cursor.app/Contents/Resources/app', rel)
  } else if (process.platform === 'win32') {
    // Windows 默认装在 %LOCALAPPDATA%\Programs\cursor（NSIS/Squirrel 默认）。
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    out.push(join(localAppData, 'Programs', 'cursor', 'resources', 'app'), rel)
    out.push(join(localAppData, 'Programs', 'Cursor', 'resources', 'app'), rel)
  } else {
    // Linux: AppImage 解包或 deb/rpm 安装都是 resources/app 布局。
    for (const root of [
      '/usr/share/cursor',
      '/usr/lib/cursor',
      '/opt/Cursor',
      join(homedir(), '.local', 'share', 'cursor'),
    ]) {
      out.push(join(root, 'resources', 'app'), rel)
    }
  }
  return out
}

/** 找到第一个实际存在的 bundle 路径；找不到返回 undefined。 */
let cachedBundle
function findBundle() {
  if (cachedBundle !== undefined) return cachedBundle
  const candidates = bundleCandidates()
  for (let i = 0; i < candidates.length; i += 2) {
    const root = candidates[i]
    const rel = candidates[i + 1]
    const full = join(root, rel)
    try {
      readFileSync(full)
      cachedBundle = full
      return full
    } catch {
      /* 下一个候选 */
    }
  }
  cachedBundle = null
  return null
}

/** protobuf-es 标量类型码 → protobufjs 类型名。 */
const SCALAR = {
  1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32',
  6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string', 10: 'group',
  11: 'message', 12: 'bytes', 13: 'uint32', 14: 'enum', 15: 'sfixed32',
  16: 'sfixed64', 17: 'sint32', 18: 'sint64',
}

/** 标量类型名集合：判断某字段的 type 是否是标量而非类型引用。 */
const SCALAR_NAMES = new Set([...Object.values(SCALAR), 'map', 'string', 'bytes', 'bool'])

/** 读取 bundle，抽取所有 makeMessageType / makeEnumType 定义。 */
function parseBundle() {
  const bundle = findBundle()
  if (!bundle) return null
  let source
  try {
    source = readFileSync(bundle, 'utf8')
  } catch {
    return null
  }
  const messages = new Map()
  const enums = new Map()

  for (const m of source.matchAll(/makeEnumType\("([\w.]+)",\(\)=>\[([\s\S]*?)\]\)/g)) {
    const values = {}
    for (const v of m[2].matchAll(/\{no:(\d+),name:"([^"]+)"/g)) values[v[2]] = Number(v[1])
    if (Object.keys(values).length) enums.set(m[1], values)
  }

  // [\s\S]*?\]\) 会跨过类型边界，把后面的 makeEnumType 内容也吞进来
  // （曾导致 ModelParameterValue 里混进 AGENT_MODE_* 枚举值）。
  // 这里改成手工扫描到配对的 ']}' 为止。
  const TYPE_RE = /makeMessageType\("([\w.]+)",\(\)=>\[/g
  for (let m = TYPE_RE.exec(source); m; m = TYPE_RE.exec(source)) {
    const typeName = m[1]
    const bodyStart = m.index + m[0].length
    let depth = 1
    let i = bodyStart
    while (i < source.length && depth > 0) {
      if (source[i] === '[') depth += 1
      else if (source[i] === ']') depth -= 1
      i += 1
    }
    const body = source.slice(bodyStart, i - 1)
    const fields = {}
    // oneof 会让多个字段共用同一个 no，protobufjs 不允许重复 id；
    // 这里只保留首个，其余丢弃（Run 请求不涉及这些 oneof 分支）。
    const usedNo = new Set()
    // 字段块内含嵌套大括号（map 的 V:{kind:...,T:...}），不能用 [^}]* 截断，
    // 否则块会被提前切断、解析出半截字段。这里按大括号配对切分。
    const blocks = []
    let depth2 = 0
    let start = -1
    for (let k = 0; k < body.length; k += 1) {
      const ch = body[k]
      if (ch === '{') {
        if (depth2 === 0) start = k
        depth2 += 1
      } else if (ch === '}') {
        depth2 -= 1
        if (depth === 0 && start >= 0) {
          blocks.push(body.slice(start, i + 1))
          start = -1
        }
      }
    }
    for (const raw of blocks) {
      const no = Number(raw.match(/no:(\d+)/)?.[1])
      const name = raw.match(/name:"([^"]+)"/)?.[1]
      if (!name) continue
      if (usedNo.has(no)) continue
      usedNo.add(no)
      const kind = raw.match(/kind:"(\w+)"/)?.[1] || 'scalar'
      const typeCode = Number(raw.match(/\bT:(\d+)/)?.[1] || 0)
      const typeVar = raw.match(/\bT:([A-Za-z0-9_$]+)[,}]/)?.[1]
      // map 字段在 Run 请求里全为空，且 protobufjs 的 map JSON 格式
      // （{keyType,value} 挂在 rule 上）过于脆弱；统一当 bytes 跳过，
      // 保留字段号与 wire type，不影响空 map 的编码。
      if (kind === 'map') {
        fields[name] = { id: no, type: 'bytes' }
        continue
      }
      fields[name] = { id: no, type: SCALAR[typeCode] || 'bytes' }
      // repeated 必须保留：丢了 rule，protobufjs 会把数组当标量编码、产出垃圾字节。
      // optional 对 proto3 标量无意义（与未设置同义），故只保留 repeated。
      if (raw.includes('repeated:!0')) fields[name].rule = 'repeated'
      if (kind === 'message' || kind === 'enum') fields[name].__typeVar = typeVar
    }
    messages.set(typeName, fields)
  }

  // 第二轮：变量别名 → 完整类型名
  const alias = new Map()
  for (const m of source.matchAll(/([A-Za-z0-9_$]+)\s*=\s*[A-Za-z0-9_$]+\.make(?:Message|Enum)Type\("([\w.]+)"/g)) {
    alias.set(m[1], m[2])
  }
  for (const [, fields] of messages) {
    for (const f of Object.values(fields)) {
      if (f.__valueVar) {
        const resolved = alias.get(f.__valueVar)
        delete f.__valueVar
        if (resolved) f.value = resolved.split('.').pop()
      }
      if (!f.__typeVar) continue
      const resolved = alias.get(f.__typeVar)
      delete f.__typeVar
      if (resolved) f.type = resolved.split('.').pop()
    }
  }
  return { messages, enums }
}

/** 把 agent.v1.* 的类型表转成 protobufjs 的 nested JSON（只含 KEEP 里的类型及其依赖）。 */
export function cursorProtoSchema() {
  const parsed = parseBundle()
  if (!parsed) return null
  const { messages, enums } = parsed
  // 全名索引：不同包里存在同名类型（如 agent.v1.UserMessage 与
  // aiserver.v1.HeadlessAgenticComposerResponse.UserMessage），
  // 只按短名存会让后写入的覆盖前者、字段类型对不上。
  const rawFull = new Map()
  for (const [typeName, fields] of messages) rawFull.set(typeName, fields)
  const enumFull = new Map()
  for (const [enumName, values] of enums) enumFull.set(enumName, values)

  /** agent.v1 命名空间内的类型优先，其余仅在被引用时使用。 */
  const resolve = (short) => {
    const nsName = `agent.v1.${short}`
    return rawFull.get(nsName) || rawFull.get(short)
  }
  const resolveEnum = (short) => enumFull.get(`agent.v1.${short}`) || enumFull.get(short)

  const raw = new Map()
  for (const name of rawFull.keys()) {
    if (!name.includes('agent.v1.')) continue
    const short = name.split('.').pop()
    if (!raw.has(short)) raw.set(short, rawFull.get(name))
  }

  // 先算出完整依赖闭包，再裁剪 —— 不能边收边降级，
  // 否则闭包外的类型会把闭包内字段的类型也污染成 bytes。
  const needed = new Set()
  const walk = (short) => {
    if (needed.has(short)) return
    const fields = raw.get(short)
    if (!fields) { needed.add(short); return }
    needed.add(short)
    for (const f of Object.values(fields)) {
      for (const ref of [f.type, f.value]) {
        if (typeof ref !== 'string') continue
        walk(ref.split('.').pop())
      }
    }
  }
  for (const k of KEEP) walk(k)

  const nested = {}
  for (const short of needed) {
    if (nested[short]) continue
    const fields = raw.get(short)
    if (fields) nested[short] = { fields: cloneFields(fields) }
    else {
      const values = resolveEnum(short)
      if (values) nested[short] = { values }
    }
  }

  // 真正无法解析的引用（跨包类型，如 ApiKeyCredentials）才降级为 bytes。
  // 注意：标量类型名（string/bool/…）本身不是类型引用，不能参与判断 ——
  // 否则所有字符串字段都会被误降级，编码出被截断的字节。
  for (const def of Object.values(nested)) {
    for (const f of Object.values(def.fields || {})) {
      // map 字段：{keyType, value} 放在 rule 上，只需降级它的 value。
      if (f.rule && typeof f.rule === 'object') {
        const v = f.rule.value
        if (typeof v === 'string' && !SCALAR_NAMES.has(v) && !nested[v.split('.').pop()]) {
          f.rule.value = 'bytes'
        }
        continue
      }
      const ref = f.type
      if (typeof ref !== 'string' || SCALAR_NAMES.has(ref)) continue
      if (!nested[ref.split('.').pop()]) f.type = 'bytes'
    }
  }
  return Object.keys(nested).length ? { nested: stripUndefined(nested) } : null
}

/**
 * 让 protobufjs 能按 "Parent.Child" 路径找到嵌套类型：
 * 为每个嵌套名建一个别名类型，字段指向短名。
 */
export function linkNestedTypes(schema) {
  const { nested } = schema
  for (const [parent, def] of Object.entries(nested)) {
    for (const f of Object.values(def.fields || {})) {
      const isMap = f.rule && typeof f.rule === 'object'
      const ref = isMap ? f.rule.value : f.type
      if (typeof ref !== 'string' || !ref.includes('.')) continue
      const tail = ref.split('.').pop()
      if (!nested[tail]) continue
      if (isMap) f.rule.value = tail
      else f.type = tail
    }
  }
  return schema
}

/** Run 请求/响应涉及的类型（作为依赖闭包的起点）。 */
const KEEP = [
  // 上行
  'AgentRunRequest', 'ConversationStateStructure', 'ConversationAction',
  'UserMessageAction', 'UserMessage', 'ModelDetails', 'RequestedModel', 'McpTools',
  // 下行
  'AgentServerMessage', 'AgentClientMessage', 'InteractionUpdate', 'ExecServerMessage',
  'ExecClientMessage', 'KvServerMessage', 'KvClientMessage',
]

/** 浅拷贝字段定义，避免多处引用同一对象被降级逻辑改坏。 */
function cloneFields(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields)) out[k] = { ...v }
  return out
}

/** protobufjs 拒绝 rule:undefined / key:undefined，统一剔除。 */
function stripUndefined(node) {
  if (Array.isArray(node)) return node.map(stripUndefined)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined) continue
      out[k] = stripUndefined(v)
    }
    return out
  }
  return node
}

/** AgentRunRequest 的必填字段号（protobuf-es 里没有 opt:!0 即 required）。 */
export function requiredRunRequestFields() {
  const parsed = parseBundle()
  if (!parsed) return []
  const fields = parsed.messages.get('agent.v1.AgentRunRequest') || {}
  return Object.values(fields).map((f) => ({ id: f.id, name: Object.keys(fields).find((k) => fields[k] === f) }))
}
/** 调试：查看某个类型的字段定义原样。 */
export function debugType(short) {
  const parsed = parseBundle()
  if (!parsed) return null
  const rawFull = new Map()
  for (const [t, f] of parsed.messages) rawFull.set(t, f)
  const hit = rawFull.get(`agent.v1.${short}`) || rawFull.get(short)
  return hit || null
}
