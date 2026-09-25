# 2026-09-25 devin-lite 初版

## 做了什么

为 `devin acp` 新建独立轻量 GUI，替代经 DSH 套壳的路径。零 npm 依赖。

## 改动清单（全部为新建）

| 文件 | 内容 |
|---|---|
| `server.mjs` | Node 后端：按需 spawn `devin acp`（隔离 ELECTRON_/WINDSURF_/VSCODE_/ACP_ 环境变量），ndjson JSON-RPC 客户端，REST API（status/sessions/list/new/load/delete/mode/config/prompt/cancel/permission/browse）+ SSE 广播（`GET /api/events`），authenticate 回退（WINDSURF_API_KEY → credentials.toml） |
| `public/index.html` | 单页骨架：顶栏（agent 信息/用量/选项栏）、侧栏（目录输入+浏览+会话列表）、对话区、输入区、目录选择弹窗 |
| `public/app.css` | 暗色样式，工具卡片/思考折叠/计划清单/权限卡片/用户气泡 |
| `public/app.js` | 前端逻辑：SSE 渲染所有 session/update（正文 markdown、思考、工具卡、计划、权限、模式/模型/思考强度选择器由 config_option_update 驱动）、会话管理（列表/过滤/打开/复制ID/删除/分页）、发送/停止、echo 抑制 |
| `devin-lite.bat` | 双击启动器（起服务+开浏览器） |
| `README.md` | 用法与结构说明 |

## 验证分层

- 静态：`node --check` 通过 server.mjs / app.js。
- 运行（已验证）：`devin acp` 握手（agentInfo=affogato）；`session/list` 返回全部历史会话；`session/load` 回放完整历史（user/thought/message/tool_call/tool_call_update/config_option_update/available_commands_update 经 SSE 到达）；`/api/browse` 目录列举正常；`/api/history` 分页已实测（heathered-ermine：6 轮，tail=5 与 to/count 翻页均正确）。
- 未验证：真实 `session/prompt` 回合（devin 配额耗尽，prompt 被拒）；权限请求交互路径只到代码层。

## 追加修复（同日）

- 「选择工作目录」弹窗空白：根因是 `browseTo` 无错误处理——无效路径触发 400 后 Promise 静默 reject，弹窗无任何内容。修复：服务端 `/api/browse` 对无效路径向上回退至最近存在祖先（而非报错）；前端 catch 后显示错误并仍给出盘符列表兜底。已验证 `D:\nonexistent\deep\dir` → 回退 `D:\` 正常列目录。
- 目录选择改为 **Windows 原生对话框**：新增 `POST /api/pick-folder`（spawn `powershell -STA` + `FolderBrowserDialog`，TopMost 宿主窗体，UTF8 输出，180s 超时，并发串行化）；前端「浏览…」直接调用、「新会话」目录为空时自动弹框；删除原自定义弹窗的 HTML/CSS/JS。静态资源响应加 `Cache-Control: no-store`，杜绝缓存旧 JS 导致的"修复看起来没生效"。已验证 PowerShell 拉起路径（进程命令行确认对话框存活）。

- 历史改为**按轮分页**：服务端为每个已加载会话缓冲 `session/update`（上限 4000 条/会话），`session/load` 回放期间不再广播、只入缓冲；新增 `GET /api/history?sessionId&tail=N|to=N&count=K`，按 `user_message_chunk` 切轮。前端打开会话只渲染**最新 2 轮**（INITIAL_TURNS=2）并强制沉底（`scrollBottom` 加 force 参数——原"近底才跟随"守卫导致加载后停在顶部）；滚到顶部（<60px）自动触发向前翻页（每页 5 轮，视口锚定不跳动，按钮兼作加载中/剩余轮数提示）；`setActive` 重置分页状态防跨会话串页；"历史超出缓冲上限"黄字提示整体移除（无意义噪音）；服务端历史缓冲上限 1500 → 4000，延长可回溯深度。
- 渲染语义对标 DSH：assistant 正文按 `messageId` 分气泡；思考/正文/工具/计划各自成块（同类连续段共享元素，类别切换即分段，不再整段历史挤进一个 blob）；用户消息独立气泡；轮间虚线分隔。
- 会话锁处理：实测 `session/resume`/`session/fork`/force `_meta` 在当前 devin acp 均不可用（-32601/-32015 依旧），锁住的会话无接管口子；侧栏改为按 `_meta['cognition.ai/isLocked']` 显示 🔒 + 悬浮提示，加载失败时给出明确中文说明。
- 一键启动：新增 `devin-lite.vbs`（无控制台窗口，启动 server + 开浏览器，重复启动无害——server 对 EADDRINUSE 静默退出）；`devin-lite.bat` 保留控制台版；已创建桌面快捷方式 `devin-lite.lnk`。
- 会话行操作改为「⋯」下拉菜单（对齐 DSH 行菜单结构）：复制会话 ID、**重命名（本地显示名覆盖）**、删除会话。分叉会话移除——实测 `session/fork`/`session/rename`/`cognition.ai/sessionRename`/`session/setTitle` 等均 -32601，当前 devin acp 未实现。重命名走 localStorage `devin-lite:titles` 映射（会话 ID → 自定义名），仅改 devin-lite 显示：侧栏、聊天头、`session_info_update` 三处统一走 `sessionTitle()`；留空恢复原标题，覆盖后悬浮显示原标题。
- 运行中状态区分：服务端 `busy` 集合跟踪在途 `session/prompt`，`/api/sessions` 行注入 `_busy` 并经 SSE `busy` 事件实时推送；侧栏运行中会话 meta 行显示绿色脉冲点 +「运行中」，所属组头计数旁加脉冲点；对话区 busy 期间底部显示三点弹跳「devin 正在处理」指示，prompt-done 移除。思考块压缩（更小的 summary/间距/透明度）缓解长回放中连续思考块的视觉墙。**修复**：`.run{display:inline-flex}` 覆盖了 `hidden` 属性导致全部会话误显示"运行中"（补 `.run[hidden]{display:none}`）；判定改为 `_busy || isLocked`（锁定≈在其他实例运行，悬浮仍区分）。
- 图片输入：`session/prompt` 支持 ACP `{type:'image', data: base64, mimeType}` 块（`/api/prompt` 接收 `images[]`，可与文字同发或单独发图，上限 8 张）；前端输入框粘贴 / composer 拖放入队为附件 chip（缩略图 + 移除钮），发送时与用户消息同泡回显；`user_message_chunk` 渲染补齐 `image`/`resource_link`/`resource` 块（DSH 端发出的附件类消息不再丢弃）。
- 横条 bug 修复：`tool_call_update` 的 `name`/`kind`/`status` 是**空字符串**而非 null，`??` 不回退导致 update 用空值覆盖掉 `tool_call` 已写入的标题/kind/状态，工具卡片渲染成无文字的薄横条。改为合并语义——只在更新携带非空值时覆盖；name/title 全空且卡片无文本时回退显示 toolCallId。
- 按会话暂存草稿：`devin-lite:drafts`（sessionId → {text, attachments}），切走存、切回恢复、发出即清；localStorage 持久化，附件超限自动降级只存文字。
- 会话切换竞态修复：`openSeq` 代次守卫——`openSession`/`renderHistoryTail`/`loadEarlier` 在 await 后校验代次与 sessionId，快速连点时只有最后一次点击的结果渲染（此前旧会话回放会渲染进新激活面板，表现即为思考块等排版串台）；`setActive` 同时重置 echo 抑制、分页、附件、打字指示。
- API 连接失败（服务未运行）给出中文指引而非裸 `Failed to fetch`。
- `devin-lite.vbs` 改为幂等：先 GET `/api/status` 探测，已运行只开浏览器接入，未运行才拉起 server（单进程 devin acp 服务多会话，按需唯一实例）。
- 侧栏复刻 DSH 工作区结构（仅复刻结构与交互，非代码移植）：顶部品牌头（SVG logo + 标题）→ 整宽「＋ 新会话」（弹原生目录选择框）→「工作区」区段（🔍 搜索开关 + ↻ 刷新）→ 按 cwd 分组的会话树：组头（折叠箭头 + 文件夹图标 + 目录名 + 会话数 + 悬浮「＋」组内新建）、组内默认显示 5 条 +「展开其余 N 个会话」、折叠/展开状态持久化 localStorage；会话行改为标题 + 相对时间，复制/删除收进悬浮图标按钮；🔒 锁标移入 meta 行。移除原 cwd 输入框/datalist/「只看当前目录」（被分组与搜索取代）。

## 未决项

- prompt 流式回合尚未在真实 devin 上跑通验证（配额原因）。
- 会话重命名未实现（devin 有 `cognition.ai/sessionRename` 扩展能力，方法名未确认，未猜）。
- 前端只渲染当前活跃会话的 update；多会话并发回合时后台会话不显示进度角标。

## 回滚路径

整个目录 `D:\devin-lite` 为新增独立目录，删除即可；不影响 DSH 仓库。
