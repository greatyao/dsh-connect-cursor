/**
 * 真·双向 HTTP/2 客户端（h2 over TLS），驱动 Cursor agent.v1.AgentService/Run。
 *
 * 为什么必须双向：`Run` 是 bidi-streaming。发出 run 请求后，服务端先发
 * `ExecServerMessage.request_context_args` 并等待客户端回 `request_context_result`，
 * 才开始模型；回合中途还会推 conversation-state blob 与内置工具调用，并阻塞等答复。
 * 任何「先把整个 body 发完再读」的半连接客户端只会收到心跳帧。
 *
 * 连接预热：TLS + ALPN + HTTP/2 preface 到 Cursor 全局端点要几个往返，
 * 否则首 token 前都要现付。`acquire()` 发出就绪连接并在后台补充连接池。
 *
 * 参考：cursor2api（MIT）的 h2stream.py，行为对齐；改用 Node 内置 http2。
 *
 * @module dsh-connect-cursor/h2
 */

import http2 from 'node:http2'
import tls from 'node:tls'

const { connect: http2Connect } = http2

/** 默认上游主机（agent Run）。 */
export const RUN_HOST = process.env.CURSOR_AGENT_HOST || 'agentn.global.api5.cursor.sh'
/** Run 路径。 */
export const RUN_PATH = '/agent.v1.AgentService/Run'
const POOL_SIZE = Number(process.env.CURSOR2API_POOL || 2)
const MAX_IDLE_MS = 40_000

/** 一个就绪的 h2 连接 + 一个已开、可立即写的流。 */
export class BidiStream {
  /**
   * @param {import('node:http2').ClientHttp2Session} session
   * @param {import('node:http2').ClientHttp2Stream} stream
   * @param {string} host
   */
  constructor(session, stream, host) {
    this.session = session
    this.stream = stream
    this.host = host
    this.created = Date.now()
    this.closed = false
    this.onData = undefined
    this.onEnd = undefined
    this.onHeaders = undefined
    this.onError = undefined
    /** 收到 WINDOW_UPDATE 时唤醒被流控阻塞的写入。 */
    this._windowWaiters = []
    this._bind()
  }

  _bind() {
    this.stream.on('response', (headers) => {
      this.onHeaders?.(headers)
    })
    this.stream.on('data', (chunk) => {
      this._drainWindow()
      this.onData?.(chunk)
    })
    this.stream.on('end', () => {
      this.closed = true
      this.onEnd?.()
      this._wakeAll()
    })
    this.stream.on('close', () => {
      this.closed = true
      this._wakeAll()
    })
    this.stream.on('error', (error) => {
      this.closed = true
      this.onError?.(error)
      this._wakeAll()
    })
    this.stream.on('window_update', () => this._drainWindow())
    this.session.on('window', () => this._drainWindow())
  }

  _drainWindow() {
    if (this._windowWaiters.length) this._wakeAll()
  }

  _wakeAll() {
    const waiters = this._windowWaiters
    this._windowWaiters = []
    for (const wake of waiters) wake()
  }

  /**
   * 写入一段负载，按实时流控窗口分块（长 prompt 超过初始 64KB 流窗口）。
   * @param {Buffer} payload
   * @param {boolean} [end=false] 写完后关闭流（半连接，仅用于非 bidi 场景）。
   */
  write(payload, end = false) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('连接已关闭'))
      let i = 0
      const sendChunk = () => {
        if (this.closed) return reject(new Error('连接已关闭'))
        if (i >= payload.length) {
          if (end) this.stream.end()
          return resolve()
        }
        const room = Math.min(
          this.stream.session?.localWindowSize?.(this.stream.id) ?? 65535,
          65535,
          payload.length - i,
        )
        const writable = room > 0 ? room : 0
        if (writable <= 0) {
          const waiter = () => sendChunk()
          this._windowWaiters.push(waiter)
          this.stream.once('window_update', () => {
            const idx = this._windowWaiters.indexOf(waiter)
            if (idx >= 0) this._windowWaiters.splice(idx, 1)
            sendChunk()
          })
          return
        }
        try {
          this.stream.write(payload.subarray(i, i + writable))
          i += writable
          // 让出事件循环，避免大负载阻塞微任务。
          setImmediate(sendChunk)
        } catch (error) {
          reject(error)
        }
      }
      sendChunk()
    })
  }

  /** 半关闭（不再写，但仍可读）——bidi 协议不需要，保留给 unary 调用。 */
  endHalf() {
    this.stream.end()
  }
}

/** 建立到 host 的 TLS h2 会话并发起一个 POST 流（无鉴权头，供预热池用）。 */
function openStream(host, path, headers) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, host, { servername: host, ALPNProtocols: ['h2'] })
    socket.once('error', reject)
    socket.once('secureConnect', () => {
      if (socket.alpnProtocol !== 'h2') {
        socket.destroy()
        return reject(new Error('ALPN 未协商到 h2'))
      }
      // http2.connect 需要完整 URL；createConnection 复用已协商好 ALPN 的 TLS socket。
      const session = http2Connect(`https://${host}`, { createConnection: () => socket })
      session.once('error', reject)
      const stream = session.request({
        ':method': 'POST',
        ':authority': host,
        ':scheme': 'https',
        ':path': path,
        ...headers,
      })
      stream.setTimeout(0)
      resolve(new BidiStream(session, stream, host))
    })
  })
}

/** 公开：建立带鉴权头的 Run 流。 */
export function openStreamAuthed(host, accessToken, requestId) {
  return openStream(host, '/agent.v1.AgentService/Run', runHeadersWithAuth(accessToken, requestId))
}

/**
 * 公开：用完全自定义的头建立 Run 流（调试 / 覆盖客户端版本号时用）。
 * @param {string} host
 * @param {Record<string,string>} headers
 * @returns {Promise<BidiStream>}
 */
export function openStreamRaw(host, headers) {
  return openStream(host, '/agent.v1.AgentService/Run', headers)
}

/** 公开：获取一个带鉴权的 Run 流（acquire 不带鉴权头，会话侧用它）。 */
export function acquireAuthed(host, accessToken, requestId) {
  return openStreamAuthed(host, accessToken, requestId)
}

const pool = []
const filling = new Set()

/** 从连接池取一个就绪的流；没有就现连。 */
export async function acquire(host = RUN_HOST) {
  for (let i = 0; i < pool.length; i += 1) {
    if (pool[i].host === host && !pool[i].closed) {
      const conn = pool.splice(i, 1)[0]
      if (Date.now() - conn.created < MAX_IDLE_MS) return conn
      conn.session.close()
    }
  }
  return openStream(host, '/agent.v1.AgentService/Run', runHeaders())
}

/** Run 请求公共头。 */
function runHeaders() {
  return {
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'connect-accept-encoding': 'gzip',
    'user-agent': 'connect-es/1.6.1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': process.env.CURSOR_CLI_VERSION || 'cli-2026.08.11-e8db854',
    'x-ghost-mode': 'false',
  }
}

/** 带鉴权的 Run 头（access token 由调用方注入到 authorization）。 */
export function runHeadersWithAuth(accessToken, requestId) {
  return {
    ...runHeaders(),
    authorization: `Bearer ${accessToken}`,
    'x-request-id': requestId,
    'x-original-request-id': requestId,
  }
}

/** 后台补充连接池。 */
export function prewarm(host = RUN_HOST, count = POOL_SIZE) {
  if (count <= 0) return
  if (filling.has(host) || pool.filter((c) => c.host === host).length >= count) return
  filling.add(host)
  const fill = async () => {
    try {
      while (pool.filter((c) => c.host === host).length < count) {
        const conn = await openStream(host, '/agent.v1.AgentService/Run', runHeaders())
        pool.push(conn)
      }
    } catch {
      /* 预热失败：下次 acquire 现连即可 */
    } finally {
      filling.delete(host)
    }
  }
  fill()
}

/** 关闭会话（进程退出时调用）。 */
export function closeAll() {
  for (const conn of pool) {
    try {
      conn.session.close()
    } catch {
      /* ignore */
    }
  }
  pool.length = 0
}
