# devin-lite

[Devin CLI](https://docs.devin.ai/cli) 的极轻量本地 GUI。零 npm 依赖：一个 `server.mjs`（Node ≥ 18）spawn 单个 `devin acp` 子进程，用 ndjson JSON-RPC over stdio 直连 ACP 协议，REST + SSE 桥接到单页前端——替代 Devin Desktop 重客户端，也绕开了中间层的插件栈。

## 快速开始

前置：Node.js ≥ 18 + 已登录的 `devin` CLI（`devin` 在 PATH 中，或用 `DEVIN_EXE` 指定）。

双击 **`devin-lite.vbs`**（桌面快捷方式 `devin-lite.lnk` 同效）：幂等——先探测已有服务，已运行则只打开浏览器接入，未运行才拉起服务；无控制台黑窗。

或命令行（保留日志窗口）：

```bat
devin-lite.bat
:: 或
node server.mjs        :: 默认 http://127.0.0.1:8317
node server.mjs 9000   :: 自定义端口
```

## 架构

```
浏览器 (public/*)  ──REST/SSE──>  server.mjs  ──ndjson JSON-RPC──>  devin acp（唯一实例）
```

- **单 acp 进程服务全部会话**：`session/load` 可同时装载多个 sessionId，与其他 devin 客户端并行存在
- `session/load` 的回放 update **不直接喷给前端**——服务端按会话缓冲（上限 4000 条），前端按"轮"分页拉取
- 不绑定网页生命周期：server 常驻持有 acp；关闭/重开浏览器只是断开/重连 SSE
- 静态资源 `Cache-Control: no-store`，改前端刷新即生效

## 功能

**侧栏（仿 DSH 工作区结构）**

- 会话按工作目录分组成树：折叠箭头 + 目录名 + 会话数；组悬浮「＋」在该目录直接新建；组按最近活跃度排序；折叠/展开状态持久化
- 每组默认显示 5 条 + 「展开其余 N 个会话」
- 🔍 搜索（标题/ID 过滤）、↻ 刷新、底部「加载更多」翻页（`session/list` cursor）
- 行内状态：绿色脉冲点 +「运行中」（本进程在途 prompt，或被其他实例打开/锁定）、🔒 锁定标记
- 行尾「⋯」菜单：复制会话 ID、重命名（**本地显示名**，存 localStorage；devin acp 未实现服务端 rename）、删除

**会话与历史**

- 打开会话只渲染**最新 2 轮**并沉底；滚到顶部自动向前翻页（每页 5 轮，视口锚定不跳）；快速连点只有最后一次生效（代次守卫）
- 渲染语义区分：用户气泡 / 助手正文（按 messageId 分气泡，轻量 markdown）/ 可折叠思考 / 工具卡片（kind·标题·状态·参数·diff·终端，点开详情）/ 计划清单 / 权限请求按钮
- 回合中「停止」（`session/cancel`）；busy 时底部三点弹跳指示

**输入**

- 粘贴/拖放**图片** → 附件 chip → 以 ACP `{type:'image'}` 块发送（≤8 张）
- 📎 按钮调 Windows 原生**文件选择框** → 以**路径引用**发送（devin 本地读文件，不复制内容）；拖放非图片文件尽力取路径，取不到则提示用 📎
- **按会话暂存草稿**：文字 + 附件随会话切换自动保存/恢复（localStorage，发出即清）

**顶栏**

- 模式（Code/Smart/Ask/Plan/Bypass）、模型、思考强度——由 `config_option_update` 驱动动态渲染，实时切换（`session/set_config_option` / `session/set_mode`）
- 上下文 token 用量角标

## 已知限制

- **锁定的会话无法接管**：`session/resume`/`session/fork`/force `_meta` 在当前 devin acp 均未实现（-32601）；在其他实例打开的会话需先在那里关闭
- 「运行中」指示对本进程在途 prompt 是准确的；其他进程内的运行状态协议不暴露，以锁定态近似
- 历史缓冲 4000 条/会话，更久远的部分不回溯（分页源是回放流，非磁盘日志）
- 文件引用只发路径——需 devin 能访问该本地路径

## 文件结构

| 文件 | 说明 |
|---|---|
| `server.mjs` | HTTP + SSE + REST + `devin acp` 子进程管理（隔离 IDE 环境变量） |
| `public/index.html` | 页面骨架 |
| `public/app.css` | 样式 |
| `public/app.js` | 前端逻辑（侧栏/流式渲染/分页/草稿/附件） |
| `devin-lite.vbs` | 幂等静默启动器（先探测后拉起） |
| `devin-lite.bat` | 控制台启动器（保留日志） |
| `tools/probe-resume.mjs` | ACP 会话锁/方法探测脚本（调试参考） |
| `变更记录/` | 结果级变更记录 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `DEVIN_LITE_PORT` | 端口（默认 8317；也可 `node server.mjs <port>`） |
| `DEVIN_EXE` | devin 可执行文件（默认 `devin`） |
| `WINDSURF_API_KEY` | 认证回退（否则读 devin `credentials.toml`） |

## REST 一览（给其他客户端复用同一 acp 实例）

`GET /api/status` · `GET /api/sessions` · `POST /api/sessions/new|load|delete|mode|config` · `GET /api/history` · `POST /api/prompt` · `POST /api/cancel` · `POST /api/permission` · `POST /api/pick-folder` · `POST /api/pick-file` · `GET /api/events`（SSE：update/busy/permission/prompt-done）
