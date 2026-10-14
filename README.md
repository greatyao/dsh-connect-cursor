# dsh-connect-cursor

把本机已登录的 Cursor 桌面应用的模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`），在 dsh 的模型选择器里直接使用 Cursor 账号能调用的模型。

> 非官方。逆向自 Cursor 的 `agent.v1.AgentService/Run` 私有协议（ConnectRPC + Protobuf + HTTP/2 双向流），与 Cursor（Ansysphere）、DeepSeek 均无关联。仅供个人学习研究。

## 工作原理

- 读 Cursor 桌面应用的登录态（`state.vscdb` 里的 JWT），不启动额外 OAuth
- 通过 HTTP/2 双向流调用 `agent.v1.AgentService/Run`，用原生 `LlmAdapter` 把 Cursor 的流式增量翻成 dsh 的 `StreamChunk`（不走 loopback 代理）
- 模型目录通过 `AvailableModels` unary 调用实时拉取

## 凭据来源（按优先级）

1. `CURSOR_ACCESS_TOKEN` 环境变量
2. 桌面应用 `state.vscdb`（SQLite，需 Node 22.5+ 内置 `node:sqlite`）
3. CLI 的 `auth.json`（macOS/Linux `~/.config/cursor/`，Windows `%APPDATA%\Cursor\`）
4. `CURSOR_API_KEY`（`crsr_` 开头，换取短期 token）

均为只读，不写入桌面应用文件。JWT 约 1 小时有效，由运行中的桌面应用刷新；过期时重新打开 Cursor 即可。

## 已知限制

- 协议私有、版本门控：`x-cursor-client-version` 过期会被上游以误导性限流错误拒绝，用 `CURSOR_CLI_VERSION` 跟一个真实 CLI 版本号
- `model_details.model_id` 必须是默认 variant 的 slug（如 `claude-sonnet-5-thinking-high`），基础 id 会被拒为 `ERROR_BAD_MODEL_NAME`
- `UserMessageAction` 必须带 `request_context`（缺了服务端只发心跳不产出）
- protobuf schema 从 Cursor 自带的 `workbench.desktop.main.js` 提取（约 800 个类型），编码不再靠猜字段号
- token 用量统计：Cursor 不总发 `turn_ended`，`usage` 可能为空

## 安装

```sh
dsh plugin --profile web add github:greatyao/dsh-connect-cursor
```

安装后重启 dsh，模型选择器出现 `cursor` 分组。

## 开发

```sh
node --test test/*.test.js   # 46 个单测
```

## 平台支持

macOS / Windows / Linux。插件按平台探测 Cursor 桌面应用的安装位置：

- macOS：`/Applications/Cursor.app/Contents/Resources/app`
- Windows：`%LOCALAPPDATA%\Programs\cursor\resources\app`
- Linux：`/usr/share/cursor/resources/app`、`/opt/Cursor/resources/app`

非默认安装位置用 `CURSOR_APP_PATH` 指向应用根目录，或用 `CURSOR_WORKBENCH_BUNDLE` 直接指向 `workbench.desktop.main.js`。

凭据按平台读取：macOS `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`、Windows `%APPDATA%\Cursor\User\globalStorage\state.vscdb`、Linux `~/.config/Cursor/User/globalStorage/state.vscdb`。需 Node 22.5+（内置 `node:sqlite`）。

Windows 上未实测；如遇问题请提 issue。

## 免责声明

仅供个人学习研究使用。使用者需遵守 Cursor 的服务条款，因使用本项目产生的后果由使用者自行承担。

## 许可证

MIT
