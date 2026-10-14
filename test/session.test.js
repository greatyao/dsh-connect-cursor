import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  requestedModel, userMessageAction, conversationAction, modelDetails,
  encodeMcpTools, clientToolName, runRequest, wrapRunRequest,
} from '../lib/session.js'
import { get, getAll, getVar, parse, decodeVarint } from '../lib/pb.js'

test('requestedModel: 模型名 + 参数编码正确', () => {
  const buf = requestedModel('claude-sonnet-5', { thinking: 'true', effort: 'high' })
  assert.equal(get(buf, 1).toString('utf8'), 'claude-sonnet-5')
  const params = getAll(buf, 3).map((p) => [get(p, 1).toString(), get(p, 2).toString()])
  assert.deepEqual(params, [['thinking', 'true'], ['effort', 'high']])
})

test('requestedModel: 无参数时只有模型名', () => {
  const buf = requestedModel('composer-2.5', {})
  assert.equal(get(buf, 1).toString('utf8'), 'composer-2.5')
  assert.equal(getAll(buf, 3).length, 0)
})

test('userMessageAction: UserMessageAction{f1 user_message, f2 request_context}', () => {
  const buf = userMessageAction('hello world', 'msg-1')
  // f1 = UserMessage{f1:text, f2:message_id}，f2 = RequestContext{f20:空 map}
  const message = get(buf, 1)
  assert.equal(get(message, 1).toString('utf8'), 'hello world')
  assert.equal(get(message, 2).toString('utf8'), 'msg-1')
  assert.ok(get(buf, 2), '必须有 request_context，否则服务端静默不产出 token')
  // 层级校验：f1 必须正好是 UserMessage（text/msg_id），不能再多包一层。
  // 曾经写成 f1: {f1: {f1:text, f2:msg_id}}，服务端按错长度截断后静默无输出。
  assert.equal(parse(message).length, 2, 'UserMessage 恰好两个字段：text 与 message_id')
})

test('encodeMcpTools: 工具名 + description + input_schema_json', () => {
  const buf = encodeMcpTools([{ name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } }])
  const def = get(buf, 1) // mcp_tools wrapper
  const tool = get(def, 1) // first McpToolDefinition
  assert.equal(get(tool, 1).toString('utf8'), 'read_file')
  assert.equal(get(tool, 2).toString('utf8'), 'read a file')
  const schema = JSON.parse(get(tool, 6).toString('utf8'))
  assert.equal(schema.type, 'object')
})

test('encodeMcpTools: 空数组 → 空 buffer', () => {
  assert.equal(encodeMcpTools([]).length, 0)
  assert.equal(encodeMcpTools(undefined).length, 0)
})

test('clientToolName: 撞 Cursor 内置名的工具加后缀', () => {
  assert.equal(clientToolName('read'), 'read_dsh')
  assert.equal(clientToolName('web_search'), 'web_search_dsh')
  assert.equal(clientToolName('read_file'), 'read_file_dsh') // read_ 前缀
  assert.equal(clientToolName('my_custom_tool'), 'my_custom_tool') // 不撞名
})

test('runRequest: 含 conversation_state / action / model_details / run_id', () => {
  const buf = runRequest({
    conversationState: Buffer.from('state'),
    action: Buffer.from('action'),
    modelDetails: modelDetails('slug-x', 'Name'),
    requestedModel: Buffer.from('model'),
    conversationId: 'conv-1',
    runId: 'run-1',
  })
  assert.ok(get(buf, 3), 'model_details 是必填字段')
  assert.deepEqual(get(buf, 1), Buffer.from('state'))
  assert.deepEqual(get(buf, 2), Buffer.from('action'))
  assert.deepEqual(get(buf, 9), Buffer.from('model'))
  assert.equal(get(buf, 25).toString('utf8'), 'run-1')
})

test('runRequest: mcp_tools(field 4) 与 conversation_id(field 5) 不互相覆盖', () => {
  const buf = runRequest({
    conversationState: Buffer.alloc(0),
    action: Buffer.from('action'),
    modelDetails: modelDetails('slug-x', 'Name'),
    mcpTools: Buffer.from('tools'),
    conversationId: 'conv-1',
  })
  assert.deepEqual(get(buf, 4), Buffer.from('tools'))
  assert.equal(get(buf, 5).toString('utf8'), 'conv-1')
})

test('conversationAction: 外层长度必须准确（少算一层会让服务端静默截断）', () => {
  const action = conversationAction('hi', 'm1')
  assert.equal(action[1], action.length - 2, '外层长度声明必须等于实际内容长度')
  const inner = get(action, 1)
  assert.ok(get(inner, 1), 'f1 = UserMessageAction')
  assert.ok(get(inner, 2), 'f2 = request_context（缺了服务端不产出 token）')
})

test('wrapRunRequest: 包成 AgentClientMessage.f1', () => {
  const runReq = Buffer.from('aabbcc', 'hex')
  const wrapped = wrapRunRequest(runReq)
  assert.equal(wrapped[0], 0x0a, '首字节是 field 1 wire 2')
  assert.deepEqual(get(wrapped, 1), runReq)
})
