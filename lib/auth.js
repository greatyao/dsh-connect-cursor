/**
 * Cursor 凭据解析：复用本机已登录的 Cursor 桌面/CLI 登录态。
 *
 * 凭据来源（按优先级）：
 *   1. CURSOR_ACCESS_TOKEN 环境变量（显式覆盖）
 *   2. 桌面应用 state.vscdb（SQLite）里的 cursorAuth/accessToken —— 主路径
 *   3. CLI 的 ~/.config/cursor/auth.json —— 兜底
 *   4. CURSOR_API_KEY（crsr_ 开头的 API key，向 Cursor 换取短期 token）
 *
 * 只读：所有来源都以只读方式打开，绝不写入桌面应用的文件。token 是 JWT，
 * 通过解码 payload 的 exp 判断过期（Cursor 的 token 约 1 小时有效，由运行中的
 * 桌面应用持续刷新；插件不自行续期，过期时提示重新打开 Cursor）。
 *
 * @module dsh-connect-cursor/auth
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** API base（token 交换 / 模型目录用）。 */
export const API_BASE = (process.env.CURSOR_API_BASE_URL || 'https://api2.cursor.sh').replace(/\/+$/, '')
/**
 * 桌面应用 User 数据根目录候选（按平台列出，存在即用）。
 *
 * 之前用 `.filter(dir => dir && !dir.startsWith('Cursor'))` 排空 APPDATA，
 * 但 Windows 上 APPDATA 非空时路径形如 `C:\Users\...\AppData\Roaming\Cursor\User`，
 * 不以 'Cursor' 开头，不会被误杀；真正要排除的是 `join('', ...)` 产生的相对路径。
 */
const CURSOR_USER_DIRS = [
  join(homedir(), 'Library', 'Application Support', 'Cursor', 'User'), // macOS
  join(process.env.APPDATA || '', 'Cursor', 'User'), // Windows: %APPDATA%\Cursor\User
  join(homedir(), '.config', 'Cursor', 'User'), // Linux
].filter((dir) => dir && !dir.startsWith('Cursor') && !dir.startsWith('globalStorage'))

/**
 * 解码 JWT 的 exp  epoch 秒；解析失败返回 undefined。
 * @param {string} jwt
 * @returns {number|undefined}
 */
function jwtExp(jwt) {
  try {
    const part = jwt.split('.')[1]
    const padded = part + '='.repeat(-part.length % 4)
    const body = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    return JSON.parse(body.toString('utf8')).exp
  } catch {
    return undefined
  }
}

/** JWT 是否在 skewMs 内过期或已过期。 */
export function isExpiring(jwt, skewMs = 300_000) {
  const exp = jwtExp(jwt)
  if (exp === undefined) return true
  return exp * 1000 - Date.now() < skewMs
}

/** state.vscdb 里的 cursorAuth/accessToken / refreshToken（桌面应用登录态）。 */
function readStateVscdb() {
  for (const userDir of CURSOR_USER_DIRS) {
    const db = join(userDir, 'globalStorage', 'state.vscdb')
    if (!existsSync(db)) continue
    try {
      // node:sqlite（Node 22.5+）内置；不可用则回退到 CLI auth。
      const { DatabaseSync } = loadNodeSqlite()
      const database = new DatabaseSync(db, { readOnly: true })
      const rows = database.prepare("SELECT value FROM ItemTable WHERE key = ?").all('cursorAuth/accessToken')
      const refreshRows = database.prepare("SELECT value FROM ItemTable WHERE key = ?").all('cursorAuth/refreshToken')
      database.close()
      const accessToken = extractToken(rows[0]?.value)
      const refreshToken = extractToken(refreshRows[0]?.value)
      if (accessToken) return { accessToken, refreshToken, source: 'state.vscdb', path: db }
    } catch (error) {
      // SQLite 不可用或读取失败：继续尝试下一个来源。
      continue
    }
  }
  return undefined
}

/** 载入 node:sqlite；不可用时抛出可读错误，由上层降级到 CLI auth。 */
function loadNodeSqlite() {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) {
    throw new Error('node:sqlite 不可用（需 Node 22.5+）；请改用 CLI 登录或 CURSOR_API_KEY')
  }
  return sqlite
}

/** ItemTable.value 可能是 JSON 字符串（带引号）或原始 token。 */
function extractToken(raw) {
  if (!raw || typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** CLI 的 auth.json 候选路径（macOS/Linux 与 Windows 各一）。 */
function cliAuthPaths() {
  const out = [join(homedir(), '.config', 'cursor', 'auth.json')] // macOS/Linux
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'Cursor', 'auth.json')) // Windows
  return out
}

/** CLI 的 auth.json。 */
function readCliAuth() {
  for (const path of cliAuthPaths()) {
    if (!existsSync(path)) continue
    try {
      const json = JSON.parse(readFileSync(path, 'utf8'))
      const accessToken = json.accessToken || json.access_token
      if (accessToken) return { accessToken, refreshToken: json.refreshToken, source: 'cli-auth', path }
    } catch {
      /* 损坏的 auth.json 跳过，试下一个候选 */
    }
  }
  return undefined
}

/** crsr_ API key → {accessToken, refreshToken}（token 约 1 小时有效）。 */
async function exchangeApiKey(key) {
  // 用内置 fetch 而不是 curl：Windows 不保证有 curl（老版本没有，Git Bash 的 curl
  // 与系统 curl 行为还不一致），fetch 在三个平台上行为一致。
  const response = await fetch(`${API_BASE}/auth/exchange_user_api_key`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`API key 交换失败：HTTP ${response.status} ${response.statusText}`)
  }
  const parsed = await response.json()
  if (!parsed.accessToken) throw new Error('API key 交换失败：响应缺少 accessToken')
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, source: 'api-key' }
}

/**
 * 解析当前可用的 Cursor 凭据。
 * @param {{allowApiKey?: boolean}} [options]
 * @returns {{accessToken: string, refreshToken?: string, source: string, path?: string, expiresAtMs?: number}}
 * @throws {Error} 找不到任何凭据时抛出，message 含可执行建议。
 */
export async function resolveCredential(options = {}) {
  const envToken = process.env.CURSOR_ACCESS_TOKEN
  if (envToken) {
    return { accessToken: envToken, source: 'env', expiresAtMs: expMs(envToken) }
  }
  const fromDb = readStateVscdb()
  if (fromDb) return { ...fromDb, expiresAtMs: expMs(fromDb.accessToken) }
  const fromCli = readCliAuth()
  if (fromCli) return { ...fromCli, expiresAtMs: expMs(fromCli.accessToken) }
  if (options.allowApiKey !== false && process.env.CURSOR_API_KEY) {
    const exchanged = await exchangeApiKey(process.env.CURSOR_API_KEY)
    return { ...exchanged, expiresAtMs: expMs(exchanged.accessToken) }
  }
  throw new Error(
    '未找到 Cursor 登录态。请确认已安装并登录 Cursor 桌面应用，' +
    '或设置 CURSOR_API_KEY（crsr_ 开头）。',
  )
}

/** JWT 的 exp → epoch 毫秒；无 exp 返回 undefined。 */
function expMs(jwt) {
  const exp = jwtExp(jwt)
  return exp === undefined ? undefined : exp * 1000
}

/**
 * 探测凭据是否可用（不抛错）。
 * @returns {{ok: boolean, credential?: object, reason?: string}}
 */
export async function probeCredential() {
  try {
    const credential = await resolveCredential()
    if (credential.expiresAtMs && credential.expiresAtMs <= Date.now()) {
      return { ok: false, credential, reason: 'token 已过期，请重新打开 Cursor 桌面应用' }
    }
    return { ok: true, credential }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
