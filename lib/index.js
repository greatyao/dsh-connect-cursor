/**
 * dsh-connect-cursor：把本机已登录的 Cursor 模型接入 DeepSeek Harness。
 *
 * 插件入口（Cordis bundle）：
 *   1. 注册 CursorAdapter 到 provider 路由 `cursor`
 *   2. 注册可配置 provider（让「设置 → 模型」页出现 cursor 条目）
 *   3. 注册模型发现（实时从 Cursor 目录拉取，刷新到 DSH 模型选择器）
 *   4. 异步刷新目录（不阻塞启动）
 *
 * @module dsh-connect-cursor
 */

import { CursorAdapter, CURSOR_PROVIDER } from './adapter.js'
import { catalog } from './models.js'
import { probeCredential } from './auth.js'

export const name = 'dsh-connect-cursor'
export const inject = ['llm']

/**
 * 插件 apply。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 插件配置
 */
export async function apply(ctx, config) {
  const adapter = new CursorAdapter()

  // 1. 注册 adapter 到 cursor 路由。
  const disposeAdapter = ctx.llm.registerAdapter([CURSOR_PROVIDER], adapter)

  // 2. 注册可配置 provider（出现在「设置 → 模型」页）。
  const namespace = CURSOR_PROVIDER
  const disposeProvider = ctx.llm.registerConfigurableProviders([
    {
      provider: CURSOR_PROVIDER,
      displayName: 'Cursor',
      settingsNs: namespace,
      settingsPath: [],
    },
  ])

  // 3. 模型发现：把 Cursor 目录翻成 DSH 模型清单。
  const disposeDiscovery = ctx.llm.registerModelDiscovery(namespace, async (request, signal) => {
    const models = await catalog()
    return models
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.id,
        name: m.display || m.id,
        contextWindow: m.context || undefined,
        inputModalities: m.images ? ['text', 'image'] : ['text'],
      }))
  })

  // 4. 异步刷新目录（不阻塞启动）。
  ;(async () => {
    try {
      const probe = await probeCredential()
      if (!probe.ok) {
        ctx.logger?.warn?.(`dsh-connect-cursor: ${probe.reason}`)
        return
      }
      await catalog(true)
      ctx.logger?.info?.('dsh-connect-cursor: 模型目录已刷新')
    } catch (error) {
      ctx.logger?.warn?.(`dsh-connect-cursor: 目录刷新失败：${error?.message || error}`)
    }
  })()

  return () => {
    disposeDiscovery()
    disposeProvider()
    disposeAdapter()
  }
}
