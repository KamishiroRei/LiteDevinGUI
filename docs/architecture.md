# Devin Lite 架构索引

## 全局索引

| 架构域 | 职责与流向 | 实现索引 |
|---|---|---|
| 进程与 ACP | `server.mjs` 启动一个 `devin acp`，将 ndjson JSON-RPC 转为 HTTP 与 SSE | 下文「ACP 与 HTTP」 |
| 会话与历史 | ACP 会话列表、装载和回放进入服务端缓存，浏览器按轮读取；本机服务另存归档元数据 | 下文「会话与历史」 |
| 延期发送 | 容量预检及 Devin 拒绝进入持久队列，到期后由服务端调度 | 下文「延期发送」 |
| 网页交互 | `public/index.html` 提供语义结构，`public/app.js` 消费 REST/SSE，`public/app.css` 负责响应式主题 | 下文「网页交互」 |
| 启动入口 | 静默和命令行两条本机启动路径 | `devin-lite.vbs`、`devin-lite.bat` |

## ACP 与 HTTP

| 模块 | 功能 | 源码定位 |
|---|---|---|
| ACP 进程 | 认证、请求响应、主动权限请求和更新流 | `server.mjs` 的 `DevinAcp` |
| 请求路由 | REST 端点、静态文件与 SSE 连接 | `server.mjs` 的 `routes`、`http.createServer` |
| 输入辅助 | Windows 原生目录/文件/剪贴板选择 | `server.mjs` 的 `pickFolderNative`、`pickFileNative`、`clipboardFilesNative` |
| 生命周期 | 启动检查、子进程归属与退出清理 | `server.mjs` 的 `killTree`、`shutdownChild` |

## 会话与历史

| 模块 | 功能 | 源码定位 |
|---|---|---|
| 会话装载 | 一个 ACP 进程装载多个会话，维护在途和回放状态 | `server.mjs` 的 `DevinAcp.ensureLoaded`、`DevinAcp.newSession` |
| 历史分页 | 将 ACP 更新分轮，按最新轮和更早轮返回 | `server.mjs` 的 `splitTurns`、`GET /api/history`；`public/app.js` 的 `renderHistoryTail`、`loadEarlier` |
| 会话归档 | 服务端持久保存归档标记和标题/工作目录，独立列出与恢复；浏览器迁移旧本地记录 | `server.mjs` 的 `loadArchive`、`saveArchive`、`archiveView`、`GET /api/archived`、`POST /api/sessions/archive`、`POST /api/sessions/unarchive`；`public/app.js` 的 `refreshArchives`、`findLegacyArchiveMetadata`、`setArchived` |
| 侧栏 | 工作目录分组、会话/归档切换、分页、搜索、菜单、当前选择与外窗占用状态推断 | `public/app.js` 的 `refreshSessions`、`renderSessions`、`sessionRow`、`displayRunning`、`setSessionView`、`openRowMenu`、`setActive` |
| 浏览器本地状态 | 每会话草稿、显示名、明暗主题、侧栏开合及当前会话 | `public/app.js` 的 `drafts`、`titleOverrides`、`setActive` 与初始化入口 |

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
| 输入与路径 | 剪贴板文件、原生选择和截图转成光标处的磁盘路径；按会话保存草稿，发送纯文本路径 | `public/app.js` 的 `beginPathInsert`、`finishPathInsert`、`stageImageDataUrl`、`send`；`server.mjs` 的 `clipboardFilesNative`、`pickFileNative`、`POST /api/attach` |

会话真实执行状态以 ACP 为准；浏览器的当前选择与主题只影响显示。归档由本机服务持久化，不调用 ACP archive。队列的绝对时间由服务端持久化，浏览器倒计时只负责展示。
