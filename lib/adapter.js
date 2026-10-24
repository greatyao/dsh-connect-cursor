/**
 * CursorAdapter：把 DSH 的 LlmAdapter 接到 Cursor 的 Run 协议。
 *
 * 实现 @deepseek-ai/dsh-llm 的 LlmAdapter 抽象类：
 *   - providerInfo / listModels / resolveModel：描述 provider 路由与模型元数据
 *   - stream(options)：跑一个 Run 回合，把 Cursor 的 InteractionUpdate 翻成 DSH 的 StreamChunk
 *
 * DSH 契约要点（与 BlockAssembler 对齐）：
 *   - 每个 block-start 都必须有配对的 block-end，否则 blocks() 收尾时抛错
 *   - finish.reason 是对象（{kind:'stop'} / {kind:'error', failure}），不是字符串
 *   - adapter.resolveModel 返回扁平的 LlmResolvedModelInfo，不是嵌套结构
 *
 * @module dsh-connect-cursor/adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { catalog, resolveModel as resolveModelId } from './models.js'
import { probeCredential } from './auth.js'
import { RunSession } from './session.js'

/** provider 路由名。 */
export const CURSOR_PROVIDER = 'cursor'

/**
 * 把 DSH GenerateOptions 翻成 Cursor 单轮输入文本。
 *
 * content 有两种形态：ContentBlock[]（协议定义）与纯字符串
 * （createUserMessage 的便捷构造实际产出的就是字符串），两种都要认。
 */
function messagesToText(messages) {
  const parts = []
  for (const message of messages || []) {
    const content = message.content
    if (typeof content === 'string') {
      if (content) parts.push(content)
      continue
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === 'text' && block.text) parts.push(block.text)
      else if (block?.type === 'image') parts.push('[图片]')
    }
    if (message.role === 'tool' && message.callId) {
      parts.push(`[tool result ${message.callId}] ${JSON.stringify(content)}`)
    }
  }
  return parts.join('\n\n')
}

/** 把 DSH tools 翻成 Cursor mcp_tools 形状。 */
function toolsToMcp(tools) {
  if (!tools?.length) return []
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    inputSchema: { type: 'object', ...(tool.parameters || {}) },
  }))
}

/** 推理档位映射：DSH 的 reasoningEffort → Cursor 的 effort 参数。 */
function effortToParam(effort) {
  if (!effort) return undefined
  const map = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }
  return map[effort] || undefined
}

/** 构造一个 LlmFailure（finish.reason 必填字段）。 */
function failure(message, code, status) {
  return status === undefined ? { message, code } : { message, code, status }
}

/**
 * 会话事件 → DSH StreamChunk 的增量翻译器。
 *
 * 持有跨批次的 block 状态（索引、累积文本、工具参数），因此必须整轮复用同一实例；
 * close() 负责补齐所有未闭合 block 的 block-end —— 这是 DSH BlockAssembler 的硬要求。
 */
export class StreamTranslator {
  constructor() {
    /** @type {Map<string, {index:number,type:string,text:string,args:string,name?:string,id?:string,started:boolean,closed:boolean}>} */
    this.entries = new Map()
    this.order = []
    this.nextIndex = 0
    this.sawTurnEnd = false
  }

  /** 取（或建）某个逻辑块的翻译状态。 */
  entry(key) {
    let state = this.entries.get(key)
    if (!state) {
      state = { index: this.nextIndex++, type: '', text: '', args: '', name: '', id: '', started: false, closed: false }
      this.entries.set(key, state)
      this.order.push(key)
    }
    return state
  }

  /** 消化一批会话事件，产出 StreamChunk。 */
  push(events) {
    const out = []
    for (const event of events) {
      if (event.type === 'text-delta') {
        const state = this.entry('text')
        if (!state.started) {
          state.started = true
          state.type = 'text'
          out.push({ type: 'block-start', index: state.index, blockType: 'text' })
        }
        state.text += event.text
        out.push({ type: 'text-delta', index: state.index, text: event.text })
      } else if (event.type === 'thinking-delta') {
        const state = this.entry('reasoning')
        if (!state.started) {
          state.started = true
          state.type = 'reasoning'
          out.push({ type: 'block-start', index: state.index, blockType: 'reasoning' })
        }
        state.text += event.text
        out.push({ type: 'reasoning-delta', index: state.index, text: event.text })
      } else if (event.type === 'tool-call') {
        const state = this.entry(`tool:${event.id}`)
        if (!state.started) {
          state.started = true
          state.type = 'tool-call'
          state.id = event.id
          state.name = event.name
          out.push({ type: 'block-start', index: state.index, blockType: 'tool-call' })
        }
        state.args += event.arguments
        out.push({
          type: 'tool-call-delta',
          index: state.index,
          id: event.id,
          name: state.name,
          argumentsDelta: event.arguments,
        })
      } else if (event.type === 'turn-ended') {
        this.sawTurnEnd = true
        out.push({
          type: 'usage',
          usage: {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheRead,
            cacheWriteTokens: event.usage.cacheWrite,
            reasoningTokens: event.usage.reasoningTokens,
          },
        })
      }
    }
    return out
  }

  /**
   * 补齐所有未闭合 block 的 block-end，并以终止 finish 收尾。
   * @param {{kind:string}} reason
   */
  close(reason) {
    const out = []
    for (const key of this.order) {
      const state = this.entries.get(key)
      if (!state.started || state.closed) continue
      state.closed = true
      if (state.type === 'text') {
        out.push({ type: 'block-end', index: state.index, block: { type: 'text', text: state.text } })
      } else if (state.type === 'reasoning') {
        out.push({ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } })
      } else if (state.type === 'tool-call') {
        out.push({
          type: 'block-end',
          index: state.index,
          block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args },
        })
      }
    }
    out.push({ type: 'finish', reason })
    return out
  }
}

/** 异步事件队列：把回调式 onEvent 变成可 await 的拉取。 */
export class EventQueue {
  constructor() {
    this.items = []
    this.done = false
    this.wakeup = null
  }

  push(item) {
    this.items.push(item)
    this.notify()
  }

  close() {
    this.done = true
    this.notify()
  }

  notify() {
    const resolve = this.wakeup
    this.wakeup = null
    resolve?.()
  }

  /** 取下一个事件；队列空且已关闭时返回 undefined。 */
  async next() {
    if (!this.items.length && !this.done) {
      await new Promise((resolve) => { this.wakeup = resolve })
    }
    return this.items.shift()
  }
}

/**
 * Cursor 的 LlmAdapter。
 */
export class CursorAdapter extends LlmAdapter {
  /** @param {{credential?: object}} [options] 注入凭据（测试用）；缺省则实时解析。 */
  constructor(options = {}) {
    super()
    this.injectedCredential = options.credential || null
  }

  /** provider 路由描述；id 必须与注册时的路由一致，否则 registerAdapter 拒绝。 */
  providerInfo(provider) {
    return {
      id: provider || CURSOR_PROVIDER,
      name: 'Cursor',
      authType: 'none',
      requiresProxy: false,
    }
  }

  /** Cursor 限流不做自动重试，直接把上游错误抛给调用方。 */
  providerRetryPolicy() {
    return undefined
  }

  /** 模型目录（供选择器展示）。 */
  async listModels(provider) {
    const models = await catalog()
    return models
      .filter((m) => !m.hidden)
      .map((m) => ({
        provider: provider || CURSOR_PROVIDER,
        id: m.id,
        name: m.display || m.id,
        inputModalities: m.images ? ['text', 'image'] : ['text'],
      }))
  }

  /** 精确模型元数据；DSH 要求返回扁平的 LlmResolvedModelInfo。 */
  async resolveModel(provider, model) {
    // 模型不在目录里时如实回报（目录随账号权限增减），不静默换模型。
    const hit = (await catalog()).find((m) => m.id === model)
    if (!hit) {
      throw new Error(
        `Cursor 目录里没有模型 "${model}"。当前账号可用：${(await catalog()).map((m) => m.id).join(', ') || '(空)'}`,
      )
    }
    return {
      provider: provider || CURSOR_PROVIDER,
      id: hit.id,
      name: hit.display || hit.id,
      inputModalities: hit.images ? ['text', 'image'] : ['text'],
      ...(hit.context ? { context: { contextWindow: hit.context } } : {}),
    }
  }

  /**
   * 跑一个流式回合。
   * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
   * @returns {AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>}
   */
  async *stream(options) {
    const translator = new StreamTranslator()
    const signal = options.signal

    const credential = this.injectedCredential || (await probeCredential()).credential
    if (!credential?.accessToken) {
      yield* translator.close({
        kind: 'error',
        failure: failure('未找到可用的 Cursor 登录态，请打开 Cursor 桌面应用或设置 CURSOR_API_KEY', 'NO_CREDENTIAL'),
      })
      return
    }

    // modelId 是服务端唯一认的 variant slug（基础 id 会被拒为 ERROR_BAD_MODEL_NAME）。
    // 模型不在目录里时 resolveModelId 抛错，转成 DSH 的 error finish 而不是让异常逃逸。
    let resolved
    try {
      resolved = await resolveModelId(options.model)
    } catch (error) {
      yield* translator.close({
        kind: 'error',
        failure: failure(error?.message || '模型解析失败', 'UNKNOWN_MODEL'),
      })
      return
    }
    const { modelId, baseId, display, params: modelParams } = resolved
    const params = { ...modelParams }
    const effort = effortToParam(options.reasoningEffort)
    if (effort) params.effort = effort

    const queue = new EventQueue()
    const session = new RunSession({
      accessToken: credential.accessToken,
      onEvent: (event) => queue.push(event),
    })

    const runPromise = session
      .run({
        text: messagesToText(options.messages),
        modelId,
        baseModelId: baseId,
        displayName: display,
        modelParams: params,
        tools: toolsToMcp(options.tools),
      })
      .catch((error) => queue.push({ type: 'error', message: error?.message || String(error) }))
      .finally(() => queue.close())

    const onAbort = () => queue.push({ type: 'error', message: '请求已取消' })
    signal?.addEventListener('abort', onAbort, { once: true })

    let runError = null
    try {
      for (;;) {
        const event = await queue.next()
        if (event === undefined) break
        if (event.type === 'error') runError = event.message
        yield* translator.push([event])
        if (runError) break
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    await runPromise

    if (signal?.aborted) {
      yield* translator.close({ kind: 'aborted', failure: failure('请求已取消', 'ABORTED') })
    } else if (runError) {
      yield* translator.close({ kind: 'error', failure: failure(runError, 'UPSTREAM') })
    } else {
      yield* translator.close({ kind: 'stop' })
    }
  }
}