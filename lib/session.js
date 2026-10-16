/**
 * 单轮流式会话：驱动 Cursor agent.v1.AgentService/Run 双向 Connect RPC。
 *
 * 协议结构（2026-10 实测校对，全部字段号以 Cursor 自带的 protobuf 定义为准）：
 *   AgentClientMessage.f1 = AgentRunRequest        ← 首帧必须包这层，否则
 *                                                      服务端回 "First message must be a run request"
 *   AgentRunRequest 必填：f1 conversation_state / f2 action / f3 model_details / f4 mcp_tools
 *   UserMessageAction 必填：f1 user_message / f2 request_context
 *   model_details.f1 model_id 必须是**默认 variant 的 slug**（如 claude-sonnet-5-thinking-high），
 *     直接用基础 id（claude-sonnet-5）会被拒：ERROR_BAD_MODEL_NAME
 *
 * 下行：AgentServerMessage.f1 = InteractionUpdate
 *   f1 text_delta / f4 thinking_delta / f13 heartbeat / f14 turn_ended
 *
 * @module dsh-connect-cursor/session
 */

import { randomUUID } from 'node:crypto'
import { deframe, encode, frame, get, getVar, msg } from './pb.js'
import { RUN_HOST, openStreamRaw, runHeadersWithAuth } from './h2.js'

/** 无新帧多久算回合结束（ms）—— Cursor 不保证发 turn_ended，只能靠空闲判断。 */
const IDLE_MS = 12_000

/** 构造 RequestedModel：模型 id + 参数（thinking/effort/...）。 */
export function requestedModel(name, params = {}) {
  return msg({
    1: name,
    3: Object.entries(params).map(([key, value]) => msg({ 1: key, 2: String(value) })),
  })
}

/**
 * 构造 ModelDetails（AgentRunRequest field 3，服务端必填）。
 *
 * 注意 modelId 必须是默认 variant 的 slug —— 服务端只认 slug，
 * 基础 id 会被拒为 ERROR_BAD_MODEL_NAME。
 */
export function modelDetails(modelId, display, baseId) {
  return msg({
    1: modelId,
    3: baseId || modelId,
    4: display || modelId,
    5: display || modelId,
    6: [],
  })
}

/** 构造 RequestContext（UserMessageAction field 2）。file_contents 是必填 map，空即可。 */
function requestContext() {
  // 只带必填的空 file_contents；带 env/workspace 会让服务端按真实工作区解析上下文。
  return msg({ 20: Buffer.alloc(0) })
}

/**
 * 构造 UserMessageAction。
 *
 * UserMessageAction{ f1: UserMessage{f1:text, f2:message_id}, f2: request_context }
 *
 * UserMessage 曾经被多包了一层 msg()，外层长度声明偏小、服务端按错长度截断，
 * 结果静默不产出任何 token（只回 turn-ended）—— 即"能连上但没输出"的根因。
 *
 * @param {string} text
 * @param {string} [messageId]
 */
export function userMessageAction(text, messageId = randomUUID()) {
  const userMessage = msg({ 1: text, 2: messageId })
  return msg({ 1: userMessage, 2: requestContext() })
}

/**
 * 构造 ConversationAction（AgentRunRequest.f2）。
 * ConversationAction{ f1: UserMessageAction } —— 这层包裹不能省。
 */
export function conversationAction(text, messageId = randomUUID()) {
  return msg({ 1: userMessageAction(text, messageId) })
}

/**
 * 构造 AgentRunRequest（注意：这是 AgentClientMessage.f1 的内容，不是首帧本身）。
 *
 * @param {object} options
 * @param {Buffer} [options.conversationState] 续聊时的会话状态；新对话不要传
 * @param {Buffer} options.action
 * @param {Buffer} options.modelDetails 必填
 * @param {Buffer} [options.requestedModel]
 * @param {Buffer} [options.mcpTools]
 * @param {string} [options.conversationId]
 * @param {string} [options.runId]
 */
export function runRequest(options) {
  const fields = {
    2: options.action,
    3: options.modelDetails,
  }
  if (options.requestedModel && options.requestedModel.length) fields[9] = options.requestedModel
  if (options.conversationState && options.conversationState.length) fields[1] = options.conversationState
  if (options.mcpTools && options.mcpTools.length) fields[4] = options.mcpTools
  if (options.conversationId) fields[5] = options.conversationId
  if (options.runId) fields[25] = options.runId
  return msg(fields)
}

/** 包成首帧：AgentClientMessage.f1 = run_request。 */
export function wrapRunRequest(runReq) {
  return encode([{ field: 1, wireType: 2, value: runReq }])
}

/**
 * 回 request_context_args（ExecServerMessage.f10）：告知客户端侧无本地上下文。
 *
 * 字段链路（实测自 Cursor 自带定义）：
 *   ExecClientMessage.f10 request_context_result
 *     → RequestContextResult.f1 success
 *       → RequestContextSuccess.f1 request_context
 * 服务端收到它才会真正开始跑模型。
 */
function requestContextResult() {
  const requestContext = msg({ 20: Buffer.alloc(0) })
  const success = msg({ 1: requestContext })
  const result = msg({ 1: success })
  // AgentClientMessage.f2 exec_client_message → f10 request_context_result
  return encode([{ field: 2, wireType: 2, value: msg({ 10: result }) }])
}

/** 新对话的 conversation_state（f5 token_details 必填；f17 是 uint32 必填）。 */
function newConversationState() {
  return msg({ 5: msg({}), 17: 0 })
}

/**
 * 编码 mcp_tools（客户端声明的工具为 MCP 工具定义）。
 * @param {Array<{name: string, description?: string, inputSchema?: object}>} tools
 */
export function encodeMcpTools(tools) {
  if (!tools?.length) return Buffer.alloc(0)
  const defs = tools.map((tool) => msg({
    1: tool.name,
    2: tool.description || '',
    6: JSON.stringify(tool.inputSchema || { type: 'object', properties: {} }),
  }))
  return msg({ 1: defs.map((d) => msg({ 1: d })) })
}

/** Cursor 内置工具名（客户端工具撞名会被整体拒绝，故加后缀区分）。 */
const BUILTIN_PREFIXES = ['read', 'write', 'edit', 'grep', 'glob', 'ls', 'shell', 'web_search', 'web_fetch']

/** 客户端声明的工具名加后缀，避免与 Cursor 内置工具撞名。 */
export function clientToolName(name) {
  return BUILTIN_PREFIXES.some((p) => name === p || name.startsWith(`${p}_`)) ? `${name}_dsh` : name
}

/** 解出一帧里的 InteractionUpdate 事件。 */
function decodeInteractionUpdate(payload) {
  const update = get(payload, 1)
  if (!update) return []
  const events = []
  const textDelta = get(update, 1)
  if (textDelta) events.push({ type: 'text-delta', text: get(textDelta, 1)?.toString('utf8') ?? textDelta.toString('utf8') })
  const thinkingDelta = get(update, 4)
  if (thinkingDelta) events.push({ type: 'thinking-delta', text: get(thinkingDelta, 1)?.toString('utf8') ?? thinkingDelta.toString('utf8') })
  const turnEnded = get(update, 14)
  if (turnEnded) {
    events.push({
      type: 'turn-ended',
      usage: {
        inputTokens: getVar(turnEnded, 1) || 0,
        outputTokens: getVar(turnEnded, 2) || 0,
        cacheRead: getVar(turnEnded, 3) || 0,
        cacheWrite: getVar(turnEnded, 4) || 0,
        reasoningTokens: getVar(turnEnded, 5) || 0,
      },
    })
  }
  return events
}

/** 解一条 AgentServerMessage，产出会话事件。 */
function decodeServerMessage(payload) {
  const events = decodeInteractionUpdate(payload)
  const exec = get(payload, 2)
  if (exec) {
    if (get(exec, 10)) events.push({ type: 'request-context' })
    if (get(exec, 11)) events.push({ type: 'mcp-args' })
    const kv = get(exec, 4)
    if (kv) events.push({ type: 'kv', blob: kv })
  }
  const checkpoint = get(payload, 3)
  if (checkpoint) events.push({ type: 'kv', blob: checkpoint })
  return events
}

/**
 * 跑一个 Run 回合。
 *
 * 产出的会话事件（text-delta / thinking-delta / turn-ended / error）由
 * adapter 翻译成 DSH StreamChunk。
 */
export class RunSession {
  /**
   * @param {object} deps
   * @param {string} deps.accessToken
   * @param {(event: SessionEvent) => void} deps.onEvent
   * @param {string} [deps.host]
   */
  constructor({ accessToken, onEvent, host, answerContext = true }) {
    this.accessToken = accessToken
    this.onEvent = onEvent
    this.host = host
    /** 是否回应 request_context_args；关掉它可观察服务端在等什么。 */
    this.answerContext = answerContext
    this.requestId = randomUUID()
    this.runId = randomUUID()
    this.conversationId = randomUUID()
    this.conversationState = null
    /** 回报给 Cursor 的工作区路径（仅用于 request_context 握手）。 */
    this.workspacePath = process.cwd()
  }

  /** 回应服务端的 request_context_args：告知客户端侧的环境与工作区。 */
  respondContext(stream) {
    stream.write(frame(requestContextResult())).catch(() => {})
  }

  /**
   * 跑一个回合。
   * @param {object} options
   * @param {string} options.text 用户输入
   * @param {string} options.modelId 默认 variant 的 slug（服务端只认这个）
   * @param {string} [options.baseModelId] 基础模型 id，用于展示名
   * @param {string} [options.displayName]
   * @param {Record<string, string>} [options.modelParams]
   * @param {Array<{name: string, description?: string, inputSchema?: object}>} [options.tools]
   * @param {number} [options.timeoutMs]
   */
  async run({ text, modelId, baseModelId, displayName, modelParams = {}, tools = [], timeoutMs = 300_000 }) {
    const stream = await openStreamRaw(this.host || RUN_HOST, runHeadersWithAuth(this.accessToken, this.requestId))

    let buffer = Buffer.alloc(0)
    let settled = false
    const finished = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          this.onEvent({ type: 'error', message: 'Cursor Run 超时' })
        }
        resolve()
      }, timeoutMs)

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (idle) clearTimeout(idle)
        resolve()
      }

      // Cursor 不保证发 turn_ended，而心跳帧会持续到达、让"无新帧"永不成立。
      // 所以单独记一个"内容空闲"计时：只被文本/思考增量重置，心跳不重置它。
      let sawContent = false
      let idle = null
      const armIdle = () => {
        if (!sawContent) return
        if (idle) clearTimeout(idle)
        idle = setTimeout(finish, IDLE_MS)
      }

      stream.onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        const [frames, rest] = deframe(buffer)
        buffer = rest
        for (const { flag, payload } of frames) {
          if (flag & 0x02) {
            this.onEvent({ type: 'error', message: payload.toString('utf8') })
            finish()
            continue
          }
          for (const event of decodeServerMessage(payload)) {
            if (event.type === 'text-delta' || event.type === 'thinking-delta') {
              sawContent = true
              armIdle()
            }
            if (event.type === 'request-context' && this.answerContext) this.respondContext(stream)
            if (event.type === 'kv' && event.blob?.length) this.conversationState = event.blob
            if (event.type === 'turn-ended') {
              this.onEvent(event)
              finish()
              continue
            }
            this.onEvent(event)
          }
        }
      }
      stream.onEnd = finish
      stream.onError = (error) => {
        this.onEvent({ type: 'error', message: error.message })
        finish()
      }
    })

    const request = runRequest({
      conversationState: this.conversationState || newConversationState(),
      action: conversationAction(text),
      modelDetails: modelDetails(modelId, displayName, baseModelId),
      requestedModel: requestedModel(modelId, modelParams),
      mcpTools: encodeMcpTools(tools),
      conversationId: this.conversationId,
      runId: this.runId,
    })
    await stream.write(frame(wrapRunRequest(request)))
    // 服务端不一定发 turn_ended（实测只发心跳直到流保持），所以给 finished 加一个
    // 兜底：收到过一次内容后若一段时间无新帧，也按正常结束处理。
    await finished
    try {
      stream.session.destroy()
    } catch {
      /* 连接已关闭 */
    }
  }
}

/**
 * 会话事件（adapter 翻译成 DSH StreamChunk 用）。
 * @typedef {Object} SessionEvent
 * @property {'text-delta'|'thinking-delta'|'turn-ended'|'request-context'|'mcp-args'|'kv'|'error'} type
 */