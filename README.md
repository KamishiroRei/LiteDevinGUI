# devin-lite

[Devin CLI](https://docs.devin.ai/cli) 的极轻量本地 GUI。零 npm 依赖：一个 `server.mjs`（Node ≥ 18）spawn 单个 `devin acp` 子进程，用 ndjson JSON-RPC over stdio 直连 ACP 协议，REST + SSE 桥接到单页前端——替代 Devin Desktop 重客户端，也绕开了中间层的插件栈。

## 快速开始

前置：Node.js ≥ 18 + 已登录的 `devin` CLI（`devin` 在 PATH 中，或用 `DEVIN_EXE` 指定）。

双击 **`devin-lite.vbs`**（桌面快捷方式 `devin-lite.lnk` 同效）：幂等——先用不触发 ACP 启动的 `/api/health` 探测 Lite 服务，已运行则只打开浏览器接入，未运行才拉起服务；无控制台黑窗。浏览器连接时会启动缺失的 Devin ACP，左下角也可手动启动或重启；正在运行的回合不会被手动重启打断。

或命令行（保留日志窗口）：

```bat
devin-lite.bat
:: 或
node server.mjs        :: 默认 http://127.0.0.1:8317
node server.mjs 9000   :: 自定义端口
```

## 架构

模块职责与源码入口见 [架构索引](docs/architecture.md)。

```
浏览器 (public/*)  ──REST/SSE──>  server.mjs  ──ndjson JSON-RPC──>  devin acp（唯一实例）
```

- **单 ACP 进程服务统一入口的全部会话**：网页、Codex 桥梁及通过桥梁创建的 Devin 同级会话共享 Lite 持有的 `devin acp`；`session/load` 可装载多个 sessionId
- `session/load` 的回放 update **不直接喷给前端**——服务端按会话缓冲（上限 4000 条），前端按"轮"分页拉取
- 不绑定网页生命周期：server 常驻持有 acp；关闭/重开浏览器只是断开/重连 SSE
- 静态资源 `Cache-Control: no-store`，改前端刷新即生效

## 功能

**侧栏（仿 DSH 工作区结构）**

- 会话按工作目录分组成树：折叠箭头 + 目录名 + 会话数；组悬浮「＋」在该目录直接新建；组按最近活跃度排序；折叠/展开状态持久化
- 每组默认显示 5 条 + 「展开其余 N 个会话」
- 工作区分组使用 Devin 会话创建时的 `cwd`。Codex/桥梁新建同一项目的任务会话时应传项目或独立 checkout 根目录；任务书与隔离目录可放在任务子目录，通过绝对路径交给执行者
- 🔍 搜索（显示名/原标题/路径/ID 过滤）、↻ 刷新、底部「加载更多」翻页（`session/list` cursor）；自动刷新保留已加载的旧页
- 行内状态：本服务在途 prompt 显示绿色「运行中」；其他实例锁定且执行状态不可读时，默认显示「运行中 · 其他窗口」，提示说明这是占用推断；工作区标题也显示活动点
- 「新会话」按钮旁显示当前 Devin 并发占用（如 `2/10`）；悬浮提示剩余名额，状态不可读时显示 `?/10`。创建空会话仍可进行；网页主动发送会立即尝试投递，后端拒绝时在该消息上显示失败
- 行尾「⋯」菜单：复制会话 ID、重命名（**本地显示名**，存 localStorage；devin acp 未实现服务端 rename）、归档/恢复、删除；侧栏「会话 / 已归档」标签可直接切换。归档元数据由本机服务持久化，独立于普通会话分页；旧版浏览器归档会在首次连接新服务时迁移

**会话与历史**

- 打开会话只渲染**最新 2 轮**并沉底；滚到顶部自动向前翻页（每页 5 轮，视口锚定不跳）；快速连点只有最后一次生效（代次守卫）
- 渲染语义区分：用户气泡 / 助手正文（按 messageId 分气泡，支持表格和复制）/ 可折叠思考 / 工具卡片（kind·标题·状态·参数·diff·终端，点开详情）/ 计划清单 / 权限请求按钮
- 刷新页面会恢复当前会话，工作区侧栏可收起；亮色与暗色主题可切换并记住选择。左下角连接状态以 ACP 初始化结果为准，断开后可点重启图标恢复
- 回合中可继续输入并直接发送插话；「停止」（`session/cancel`）与底部运行指示仍跟随当前会话

**输入**

- 在资源管理器复制任意文件或文件夹后，直接粘贴进句子，输入框在光标处插入绝对路径。例如 `你给我查看D:\Game\DNF\国服115.pvf来理解`；发送的是这段文字，Devin 按路径读取磁盘文件
- 复制磁盘上的图片文件后粘贴，直接引用原路径；剪贴板只有位图数据时，输入框立即出现 `@图片1` 与悬浮预览，后台以二进制保存一次到 `attachments/`。发送前将 `@图片1` 展开为磁盘路径，Devin 收到的仍是文本路径
- 在当前会话输入 `@`，可按缩略图和文件名选择已出现的图片，再次插入 `@图片N` 引用；支持方向键、Enter、鼠标选择。对话中的图片路径显示为可悬浮的图片框，周围文字保持原样
- 未发送的图片引用从草稿删除后即从临时索引移除，后续粘贴复用空出的 `图片N` 编号；已经发送或从历史发现的图片仍保留在本会话 `@` 列表
- 📎 按钮可原生多选文件：图片转成可预览的引用，其他格式插入原路径。拖入文件时若浏览器未提供磁盘路径，会提示改用复制粘贴或文件选择
- **按会话暂存草稿**：文字输入后自动保存，切换会话或重开页面可恢复（localStorage，发出即清）；旧版附件占位符在装载草稿时转成路径文字

**顶栏**

- 模式（Code/Smart/Ask/Plan/Bypass）、模型、思考强度——由 `config_option_update` 驱动动态渲染，实时切换（`session/set_config_option` / `session/set_mode`）
- 上下文 token 用量角标

**排队反馈**

- 输入区上方默认展开所有会话的待处理消息，逐条显示来源、所属会话、内容摘要、等待原因、重试倒计时与尝试次数；长消息可按需查看全文，可打开会话、手动重试或取消尚未发送的项目。发送中的项目显示状态，侧栏也显示该会话的排队条数
- 排队事件以独立提示显示，不会写进其他会话的对话历史；页面重开后从服务端重新读取排队状态

**并发延期队列**

共享并发预算与 Codex 协作桥梁同口径，固定上限 5 条。新 Devin 执行者和 Devin 内部派生任务仍做容量准入。网页用户主动发送与外部主控发给已有会话的 action 直接进入同一 ACP；向运行中会话插话不新增名额，向闲置会话发送则须有空位。达到 5 条或容量不可读时拒绝新增执行；显式发送若被拒绝，明确反馈失败，不暗中排队重发。普通桥梁回合遭并发/配额拒绝时进入延期队列，同会话较早的延期项先发送。错误携带分钟、秒数或结构化期限时按 `期限+5s` 定时重发；所有被拒绝的队列项至少等待 30 秒，未给期限时按 30 秒下限和容量检查节奏重试，期限之前不自动派发。用户点「立即重试」可针对所选项目提前尝试，但满额时保留队列项而不投递。队列持久化在 `deferred-prompts.json`，重启自动恢复并保持延期消息的顺序；恢复发送中的记录时也至少等待 30 秒，避免立刻重复提交。「停止」会丢弃该会话尚在排队的项目。队列按容量快照准入，满额或无法读取容量时不会试探派发。

**Codex 协作统一入口**

Codex 的 `devin-session-collaboration` 桥梁默认连接本机 Lite 的 `/api/bridge/turn/start|status`，经这个服务的单个常驻 `devin acp` 创建或续跑 SWE 会话；因此 GUI 和桥梁看见同一批会话与运行状态。桥梁的 `--cwd` 只决定会话工作目录，任务文件正文才是发给 Devin 的 prompt；使用项目或独立 checkout 根目录作 `--cwd`，避免任务区被误列为工作区。Lite 不可达时桥梁会明确失败，不自动另起 Devin。回合完成后桥梁保留自身邮箱、报告和验收记录。桥梁的取消请求按 host turn 定位；同会话另有 GUI 插话时，后端会拒绝可能波及插话的会话级取消。

外部主控对已有 Devin 会话发 `send --action` 时，桥梁启动独立的直发跟踪进程，不等待该 actor 的普通 runner；消息与结果仍记录在同一个任务库。Devin 同级 action 与新会话继续遵守 5 条并发准入。ACP 接受并行 prompt 只证明请求已投递，具体何时被模型应用仍以真实回合结果为准。

桥梁 `capacity` 命令直接返回当前 `active/limit/available`；`start` 也自动附容量快照，5/5 时不创建新会话。Codex 可据此改选原生子代理；Devin 内部 `run_subagent` 必须先用 `swe_subagents.py reserve` 预留名额，满额时由当前 Devin 会话自己完成任务。预留在子代理结束或启动失败后用 `done` 释放。

桥梁本机地址默认 `http://127.0.0.1:8317`；若单宿主部署在另一端口，用 `DEVIN_BRIDGE_LITE_URL` 指定同一个本机入口。桥梁已禁用 `DEVIN_BRIDGE_TRANSPORT=cli` 的独立模型轮次；Lite 不可达时明确失败。模型证据为 ACP 已选配置或已接受设置请求，不能视作末次生成步骤的独立模型证明。

## 已知限制

- **锁定的会话无法接管**：`session/resume`/`session/fork`/force `_meta` 在当前 devin acp 均未实现（-32601）；在其他实例打开的会话需先在那里关闭
- 独立 `devin --print` 或 Desktop 持有的 ACP 是父进程私有 stdio，Lite 无法接入其在途输入流；单进程保证适用于采用 Lite 统一入口的新回合。旧独立任务须结束或取消并释放会话锁后，才能由 Lite 装载原会话。
- 其他进程内的真实执行状态 ACP 不暴露；「运行中 · 其他窗口」依据锁定状态推断，可能包含已打开但暂未生成的会话
- 已用任务子目录作 `cwd` 创建的旧会话仍按原目录显示；改发会话规则不会改写它们的历史归属
- 历史缓冲 4000 条/会话，更久远的部分不回溯（分页源是回放流，非磁盘日志）
- 文件引用只发路径——需 devin 能访问该本地路径
- 图片缩略图仅支持本机现存的 PNG/JPEG/GIF/WebP/BMP/AVIF 栅格文件；会话图片检索基于本进程装载的文本历史，旧的纯 base64 图片不具备磁盘路径，无法供 `@` 重用
- 桥梁 host turn 的状态存在内存中；Lite 重启后未知 turn ID 明确报错，须先检查会话与产物，再决定是否续跑，不能自动重复执行

## 文件结构

| 文件 | 说明 |
|---|---|
| `server.mjs` | HTTP + SSE + REST + `devin acp` 子进程管理（隔离 IDE 环境变量） |
| `public/index.html` | 页面骨架 |
| `public/app.css` | 样式 |
| `public/app.js` | 前端逻辑（侧栏/流式渲染/分页/草稿/路径插入） |
| `public/favicon.svg` | Devin Lite 网页标识 |
| `public/devin-lite.ico` | 桌面快捷方式图标 |
| `docs/architecture.md` | 架构域、模块职责和源码索引 |
| `codex-skill/devin-session-collaboration/` | 可追踪的 CODEX 协作手册、统一入口桥梁与契约检查；同步安装到本机 Codex skills 目录 |
| `devin-lite.vbs` | 幂等静默启动器（先探测后拉起） |
| `devin-lite.bat` | 控制台启动器（保留日志） |
| `tests/retry-recovery.mjs` | 独立假 ACP 回归测试：单进程恢复、手动重启和并发重试期限 |
| `tools/probe-resume.mjs` | ACP 会话锁/方法探测脚本（调试参考） |
| `deferred-prompts.json` | 并发延期队列持久化（运行期生成） |
| `archived-sessions.json` | 本机服务的会话归档元数据（运行期生成） |
| `变更记录/` | 结果级变更记录 |

## 环境变量

| 变量 | 说明 |
|---|---|
| `DEVIN_LITE_PORT` | 端口（默认 8317；也可 `node server.mjs <port>`） |
| `DEVIN_EXE` | devin 可执行文件（默认 `devin`） |
| `WINDSURF_API_KEY` | 认证回退（否则读 devin `credentials.toml`） |
| `DEVIN_LITE_CAPACITY_SCRIPT` | 容量检查脚本（默认 `swe_capacity.py` 的协作技能路径） |
| `DEVIN_LITE_PYTHON` | 跑容量脚本的解释器（默认 `python`） |
| `DEVIN_LITE_RETRY_POLL_MS` | 容量受阻时队列复查间隔（默认 30000，范围 30s–10min；后端明确期限独立于此间隔） |
| `DEVIN_LITE_PROBE_AFTER_MS` | 容量读不出时的停滞探针等待（默认 300000） |
| `DEVIN_LITE_CONCURRENCY_RE` | 并发拒绝的识别正则（覆盖默认模式时设） |

## 回归验证

运行 `node tests/retry-recovery.mjs`。脚本把服务端复制到独立临时目录并使用假 ACP 与容量桩，不读取生产会话和延期队列；验证队列逐项读取/操作、主控插话、1/2 分钟提示、无提示时 30 秒下限、到期后重发、启动恢复与忙时重启保护。

## REST 一览（给其他客户端复用同一 acp 实例）

`GET /api/health|status` · `POST /api/agent/restart` · `GET /api/sessions` · `GET /api/archived` · `POST /api/sessions/new|load|archive|unarchive|delete|mode|config` · `GET /api/history` · `GET /api/session-images` · `GET /api/image-preview` · `POST /api/prompt` · `POST /api/cancel` · `POST /api/permission` · `POST /api/pick-folder` · `POST /api/pick-file` · `POST /api/clipboard-files` · `POST /api/attach` · `POST /api/bridge/turn/start|cancel` · `GET /api/bridge/turn/status` · `GET /api/queue|queue/item` · `POST /api/queue/send|drop` · `GET /api/capacity` · `GET /api/events`（SSE：update/busy/permission/prompt-done/prompt-deferred/prompt-dispatch/bridge-turn/queue/session-archived/agent-ready/agent-down）
