# Devin Lite 架构索引

## 全局索引

| 架构域 | 职责与流向 | 实现索引 |
|---|---|---|
| 进程与 ACP | `server.mjs` 启动一个 `devin acp`，将 ndjson JSON-RPC 转为 HTTP 与 SSE | 下文「ACP 与 HTTP」 |
| Codex 协作入口 | 桥梁 runner 经本机 HTTP 进入同一 ACP；任务文件正文作为 prompt，`cwd` 只作为会话工作区 | 下文「桥梁回合」；仓库 `codex-skill/devin-session-collaboration/scripts/devin_bridge.py`，同步安装到本机 Codex skills 目录 |
| 会话与历史 | ACP 会话列表、装载和回放进入服务端缓存，浏览器按轮读取；本机服务另存归档元数据 | 下文「会话与历史」 |
| 延期发送 | 容量预检及 Devin 拒绝进入持久队列，到期后由服务端调度 | 下文「延期发送」 |
| 网页交互 | `public/index.html` 提供语义结构，`public/app.js` 消费 REST/SSE，`public/app.css` 负责响应式主题 | 下文「网页交互」 |
| 启动入口 | 静默和命令行两条本机启动路径 | `devin-lite.vbs`、`devin-lite.bat` |

## ACP 与 HTTP

| 模块 | 功能 | 源码定位 |
|---|---|---|
| ACP 进程 | 认证、请求响应、主动权限请求和更新流 | `server.mjs` 的 `DevinAcp` |
| 请求路由 | REST 端点、静态文件与 SSE 连接 | `server.mjs` 的 `routes`、`http.createServer` |
| 桥梁权限 | 桥接会话使用 bypass，权限请求按允许选项自动应答；GUI 会话保持人工权限 UI | `server.mjs` 的 `autoApproveSessions`、`session/request_permission` 处理 |
| 输入辅助 | Windows 原生目录/文件/剪贴板选择 | `server.mjs` 的 `pickFolderNative`、`pickFileNative`、`clipboardFilesNative` |
| 生命周期 | 启动检查、子进程归属与退出清理 | `server.mjs` 的 `killTree`、`shutdownChild` |

## 会话与历史

| 模块 | 功能 | 源码定位 |
|---|---|---|
| 会话装载 | 一个 ACP 进程装载多个会话，维护在途和回放状态 | `server.mjs` 的 `DevinAcp.ensureLoaded`、`DevinAcp.newSession` |
| 历史分页 | 将 ACP 更新分轮，按最新轮和更早轮返回 | `server.mjs` 的 `splitTurns`、`GET /api/history`；`public/app.js` 的 `renderHistoryTail`、`loadEarlier` |
| 会话图片索引 | 从已装载会话正文发现仍存在的本机栅格图片路径，供当前会话 `@` 重用 | `server.mjs` 的 `RASTER_PATH_RE`、`GET /api/session-images`；`public/app.js` 的 `refreshSessionImages`、`imageRefsFor` |
| 会话归档 | 服务端持久保存归档标记和标题/工作目录，独立列出与恢复；浏览器迁移旧本地记录 | `server.mjs` 的 `loadArchive`、`saveArchive`、`archiveView`、`GET /api/archived`、`POST /api/sessions/archive`、`POST /api/sessions/unarchive`；`public/app.js` 的 `refreshArchives`、`findLegacyArchiveMetadata`、`setArchived` |
| 侧栏 | 工作目录分组、会话/归档切换、分页、搜索、菜单、当前选择与外窗占用状态推断 | `public/app.js` 的 `refreshSessions`、`renderSessions`、`sessionRow`、`displayRunning`、`setSessionView`、`openRowMenu`、`setActive` |
| 浏览器本地状态 | 每会话草稿、图片标签与路径、未发送图片引用清理、显示名、明暗主题、侧栏开合及当前会话 | `public/app.js` 的 `drafts`、`imageBooks`、`pruneUnusedDraftImages`、`titleOverrides`、`setActive` 与初始化入口 |

## 桥梁回合

| 模块 | 功能 | 源码定位 |
|---|---|---|
| 创建与续跑 | `POST /api/bridge/turn/start` 使用稳定项目 `cwd` 新建/装载会话，设置 SWE-2 High 与 bypass 后向同一 ACP 发 prompt；响应前建立 busy 计数 | `server.mjs` 的 `newBridgeTurn`、`dispatchPrompt`、`POST /api/bridge/turn/start` |
| 状态与延期 | `GET /api/bridge/turn/status` 长等真实回合状态；并发拒绝沿用服务端延期队列；未知 host turn 明确 404 | `server.mjs` 的 `turnSet`、`turnView`、`deferPrompt`、`GET /api/bridge/turn/status` |
| 安全取消 | 延期项只撤本项；在途回合同 session 有别的 prompt 时拒绝会话级取消 | `server.mjs` 的 `POST /api/bridge/turn/cancel` |
| 桥梁持久协作 | 每任务 SQLite 保存 actor/邮箱/报告/验收、Lite host turn ID、容量准入和错误记录；默认不启动另一个 Devin CLI | 外部 `devin-session-collaboration/scripts/devin_bridge.py` 的 `run_lite_turn`、`lite_request`；`swe_capacity.py` |

## 延期发送

| 模块 | 功能 | 源码定位 |
|---|---|---|
| 容量读取 | 调用共享 SWE 容量脚本，给出当前可用名额 | `server.mjs` 的 `capacitySnapshot` |
| 错误期限 | 从 Devin 并发或配额错误提取重发时间 | `server.mjs` 的 `parseRetryAfterMs` |
| 队列状态 | 持久化待发送及发送中状态，对外提供列表和撤销尚未派发的项 | `server.mjs` 的 `loadQueue`、`saveQueue`、`queueView`、`GET /api/queue`、`POST /api/queue/drop` |
| 调度 | 到期与容量判断后重新进入同一会话 prompt | `server.mjs` 的 `deferPrompt`、`schedulePump`、`pumpDeferred`、`dispatchPrompt` |
| 状态显示 | SSE 加载/完成事件、侧栏计数、倒计时与取消 | `public/app.js` 的 `connectEvents`、`refreshQueue`、`updateQueueBanner` |

## 网页交互

| 模块 | 功能 | 源码定位 |
|---|---|---|
| 页面骨架 | 工作区导航、会话内容、输入和状态区域 | `public/index.html` |
| 页面主题 | 亮/暗主题、移动端布局、图标和状态样式 | `public/app.css`、`public/favicon.svg` |
| 消息呈现 | ACP 语义更新转为回复、思考、工具、计划和权限卡片 | `public/app.js` 的 `renderUpdate`、`appendAgentText`、`toolCard`、`renderPermission` |
| 输入与路径 | 磁盘文件直接引用原路径；剪贴板位图二进制落盘；输入区显示图片标签，发送时展开为纯文本路径 | `public/app.js` 的 `beginPathInsert`、`beginImageRef`、`uploadImageRef`、`send`；`server.mjs` 的 `clipboardFilesNative`、`pickFileNative`、`POST /api/attach` |
| 插话与错误归属 | 同会话忙碌时直接发送；并发消息按 clientMessageId 绑定各自的失败提示与撤回 | `public/app.js` 的 `send`、`pendingSends`、`markUserFailed`；`server.mjs` 的 `dispatchPrompt`、`POST /api/prompt` |
| 图片呈现与复用 | 用户消息中已知图片路径渲染为悬浮预览框；`@` 按缩略图选择当前会话图片 | `public/app.js` 的 `renderRefText`、`makeImageChip`、`updateMentionMenu`、`selectMention`；`server.mjs` 的 `GET /api/image-preview`；`public/app.css` 的 `.image-ref-chip`、`.image-mention-menu` |

会话真实执行状态以 ACP 为准；浏览器的当前选择与主题只影响显示。归档由本机服务持久化，不调用 ACP archive。队列的绝对时间由服务端持久化，浏览器倒计时只负责展示。
