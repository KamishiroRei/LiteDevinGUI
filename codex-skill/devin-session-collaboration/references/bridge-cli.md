# Devin 桥梁 CLI 与架构

入口：`C:\Users\ASUS\.codex\skills\devin-session-collaboration\scripts\devin_bridge.py`。本机 Python 标准库即可；状态目录由每次协作任务自己指定，互不混用。CLI 参数 `--state` 放在子命令之前。所有命令输出 JSON；一般错误写 stderr，容量满额以 stdout JSON 返回 `admitted=false` 和退出码 2。路径和长正文用独立 UTF-8 文件传递。只允许 `DEVIN_BRIDGE_TRANSPORT=lite`，由正在运行的 Devin Lite（默认 `http://127.0.0.1:8317`）持有唯一常驻 `devin acp`；桥梁 runner 只发 HTTP 请求和保存协作状态。Lite 不可达时任务明确失败，绝不静默启动第二个 Devin。端口不同可设置 `DEVIN_BRIDGE_LITE_URL`，只接受本机 HTTP。

```powershell
$bridge = 'C:\Users\ASUS\.codex\skills\devin-session-collaboration\scripts\devin_bridge.py'
$projectRoot = 'D:\Game\DNF\DNF复刻'
$taskRoot = 'D:\Game\DNF\DNF复刻\AI任务\本次任务'
$state = Join-Path $taskRoot 'bridge-state'
$prompt = Join-Path $taskRoot 'worker A\任务.txt'
python $bridge --state $state init --name '协作任务' --root codex
python $bridge --state $state capacity  # active / limit=10 / available
python $bridge --state $state start --from codex --name '实现者' --cwd $projectRoot --prompt-file $prompt
python $bridge --state $state participants
python $bridge --state $state status --actor a_返回的ID
```

`$projectRoot` 是 Devin 会话所属项目的稳定工作区；`$taskRoot` 只存本次任务的桥梁状态、任务书、隔离文件和结果。将每个 `worker A` 或 `AI任务` 子目录传给 `--cwd` 会让它们在 Devin Lite 中成为独立工作区。真正独立的项目或 checkout 才使用其自身根目录。任务范围与写入归属仍在任务书中用绝对路径写明；`--cwd` 不提供文件隔离。新建与续跑的目录选择见 [会话工作区与任务目录](../SKILL.md#会话工作区与任务目录)。

`start` 自动查询实际占用，成功结果附 `capacity_before`（含 `active/limit/available`）和桥梁 actor ID、runner PID；10/10 时返回退出码 2、`admitted=false`、`action=choose_codex_subagent`（由 Codex 发起）或 `action=self_execute`（由 Devin 发起），且不会创建 actor/turn。预检与真正派发间若发生并发竞争，后台仍会按全局锁进入 `waiting_capacity`；Codex 若要改派须先取消该待执行任务。runner 经 `/api/bridge/turn/start` 创建或加载会话，使用指定 `--cwd` 作为会话工作区，并把任务文件正文作为 prompt。真正的 session ID 在 Lite 接受回合后写入 `status` / `participants`；任务文件目录或 `--state` 目录不会冒充会话工作区。Lite 端核对并选择 `swe-2-high` 与 `bypass`，回合状态与所选模型证据写入本轮 `lite-turn.json` / `export.json`。ACP 配置只能证明已选择模型，**不能冒充 CLI 导出中末次生成步骤的模型证据**；`observed_model` 因此留空。会话的登录与权限策略由同一 Lite ACP 宿主承担，工作区信任效果仍需实际验证。

旧 `DEVIN_BRIDGE_TRANSPORT=cli` 模型执行路径已禁用；设成 `cli` 会把该轮标为失败并报告明确原因，不会启动 `devin --print`。独立 CLI 仅用于只读诊断和核对旧会话，不参与新协作回合。

## 消息路径：邮箱、下一轮与当前轮

现役桥梁有两个目的地，不能把同一个“发送成功”解释为同一种效果：

| 目的地 | 当前操作 | 可观察效果 | 当前轮直接引导 |
|---|---|---|---|
| 另一个本地 SWE | `send` | 消息立即写入 SQLite 邮箱，不建立后续 turn；目标本轮若正在 `wait` 该发送者，作为当前工具结果返回，之后 `inbox --read` | 协作式当前轮可见；不自动打断忙碌模型 |
| 另一个本地 SWE | `send --action` | 邮箱消息与 `turns` 中的后续任务同事务保存；当前回合结束后由 Lite 的原 session 执行 | 否 |
| 原 Codex 聊天 | 普通 `send` 或不带 `--final` 的 `report` | Codex 参与者的持久邮箱/报告，供主控自行读取 | 否 |
| 原 Codex 聊天 | `send --direct` | 明确有行动价值的消息先保存到邮箱与事件，再调宿主发信 | 与 Codex 会话间工具同源；真实接收尚未实测 |
| 原 Codex 聊天 | `report --final` 或 `block` | 持久事件后通过 Codex app-tools pipe 调宿主 `send_message_to_thread` | 使用与 Codex 会话间发信相同的宿主入口；真实接收尚未实测 |

默认桥梁的 `run_turn` 经 Lite HTTP 进入同一个 ACP 宿主：新会话 `session/new`，续轮 `session/load`，随后 `session/prompt`。桥梁普通 `send` 则只写任务邮箱，没有自动把消息塞入正在生成的模型；接收方主动 `wait` / `inbox` 才能在该轮看到它。Lite GUI 的“插话”直接提交另一条 prompt，可观察接受与回合状态；这仍不等于经验证的模型级 `session/inject`。上游 [ACP 注入提案](https://github.com/agentclientprotocol/agent-client-protocol/pull/2043)不能当作当前 Devin 实现。单独启动 CLI 去抢同一 session 仍不可取。

`send --direct` 仅适用于任务绑定的原 Codex 聊天，对 SWE 接收者会明确报错。SWE 同级普通 `send` 是立即写入和可在**接收方当前轮**读取的路径；不能把保存消息等同于模型已经应用。若未来 ACP 明确支持模型级注入，再按消息 ID 区分接受、送达与应用。

SWE 同级需要当轮互答时，发送方用普通 `send`，接收方在确实需要等回复时调用 `wait --self <自己> --actor <对方> --timeout <秒数>`；该命令约每秒查询一次，收到未读消息即返回，随后接收方用 `inbox --participant <自己> --read` 消费它。接收方可在继续独立工作时于有用的工具边界主动读邮箱，不需开新模型轮次。`wait` 会占用接收方当前工具调用，应只在确实需要回复时使用。若需要接收者独立续做，用 `--action`。无法以桥梁邮箱命令保证即时改变正在生成的模型。

## 原 Codex 聊天直达事件

Codex 把 SWE-2 High 作为异步自主 subagent 委派任务，一次说清目标、效果和方向，轻量确认正常启动、无明显运行故障后即可放手。有独立工作照常做，无事直接 idle，不持续查询状态或阻塞等待。桥梁的 Codex 邮箱一直可读；有行动价值的协作消息可显式 `send --direct`，受委派任务完成用 `report --final`，真实阻塞用 `block`。三者都向任务绑定的**原 Codex 聊天**发送事件索引和简短实际内容，当前适配调用宿主 `codex_app/send_message_to_thread`，不再调用 `codex queue`。普通进度继续留在邮箱。它不调用 Devin 账户中的 GPT-6，不创建新推理会话，也不定时让模型轮询。

Codex Agent 间的原生发信入口是宿主提供的 `mcp__codex_app__send_message_to_thread`；SWE 进程不直接拥有该 MCP 工具，但继承 Codex 注入的 `CODEX_APP_TOOLS_PIPE_PATH`。桥梁按现役 `codex-app-tools` 插件的本地协议发送：先对宿主 pipe 做只读 `tools/list`，确认精确工具 `codex_app/send_message_to_thread`，再用 4 字节小端长度帧承载 JSON-RPC `tools/call`；外层调用线程与工具参数目标线程都取 `meta.codex_thread` 绑定的原聊天 UUID。当前宿主 pipe 与工具目录已只读检查，未发送实战消息。pipe 路径属于宿主能力，只在受信的本机协作任务中继承，不记录到任务状态或日志。此路由复用 Codex 会话间工具，由宿主决定 active/idle 的投递，不打开另一个 App Server、Responses API 会话或 GPT-6 聊天。[OpenAI 对 Queue 与 Steer 的说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)可用于区分实际接收效果；本次不能以工具目录存在代替活跃轮直达证据。

桥梁先持久化事件 ID，再向宿主发送。发信正文包含事件 ID、actor/ref、状态目录索引和最多 2000 字符的实际消息、报告摘要或阻塞正文；超出部分留在桥梁中。宿主明确拒绝或 pipe 缺失时事件保持 `pending`，用 `wake-retry` 重试；请求写出后断连、异常返回或超时则保持 `attempting`，先查原聊天是否已有该事件 ID，再决定是否用 `wake-retry --allow-uncertain`。宿主成功返回只记 `submitted_at` / `host_accepted`；原聊天看到事件 ID 后由 Codex 用 `wake-ack` 记 `received_at`，模型是否处理还要看实际后续动作。旧 `queued` 事件保留历史状态，不自动改投造成重复消息。失败没有 `codex queue` 兜底。SWE→SWE 的运行中模型注入仍属另一条未接通的链，见上一节。

```powershell
# 新任务可在 init 时指定；已存在状态库可增量配置，不清空原队列。
python $bridge --state $state init --name '协作任务' --root codex --codex-thread '准确的现有聊天UUID'
python $bridge --state $state wake-config --thread '准确的现有聊天UUID'

# 向 Codex 交付已完成的受委派任务并发出宿主直达事件时加 --final；Devin 内部报告不用。
python $bridge --state $state report --from a_执行者 --to codex --summary-file 'C:\任务目录\结果.txt' --artifact 'C:\任务目录\产物.txt' --final
# 真实阻塞时发出一个宿主事件；普通咨询用 send。
python $bridge --state $state block --from a_执行者 --to codex --body-file 'C:\任务目录\阻塞.txt'
# 其他确需主控此刻处理的协作消息，明确标记 --direct；正文先存邮箱。
python $bridge --state $state send --from a_执行者 --to codex --body-file 'C:\任务目录\需主控处理.txt' --direct

python $bridge --state $state wake-status
python $bridge --state $state wake-retry --event w_事件ID
# Codex 端在原聊天确实看到事件标记后，再记录这一层证据。
python $bridge --state $state wake-ack --event w_事件ID
```

事件与消息、报告或阻塞正文同事务落盘；工具明确拒绝保持 `pending`，宿主已接受记 `submitted_at`，无法判定的尝试保留 `attempting`。**原聊天实际收到**须由 Codex 看到事件 ID 后用 `wake-ack` 记录 `received_at`。未配置事件路由时普通 `report`/`send` 仍可用，`send --direct`、`report --final` 和 `block` 明确报错。桥梁还提供 `wake-probe --label <标签>`，只准备一个 `pending` 标记；须显式 `wake-retry` 才会发出。本次遵用户要求没有发送探针。

唤醒消息有事件索引和简短实际内容，不带整份上下文。Codex 收到后结合整体任务整合结果或解决阻塞，完成必要验证与交付，利用 SWE 的可靠证据减少重复检查；用户接受、多模态和范围外授权仍按正常职责处理。静态连接与宿主工具成功返回不等于桌面聊天实际收到，首次真实事件仍须记录接收证据。

## 协作命令

```powershell
# 同级、父子、组织者均可发消息。普通 note 只入邮箱；action 在接收者安全轮次边界续跑原会话。
python $bridge --state $state send --from a_发送者 --to a_接收者 --body-file 'C:\任务目录\note.txt'
python $bridge --state $state send --from a_发送者 --to a_接收者 --body-file 'C:\任务目录\请求.txt' --action
python $bridge --state $state inbox --participant a_接收者
python $bridge --state $state inbox --participant a_接收者 --read
python $bridge --state $state inbox --participant a_接收者 --all

# 明确目标的续轮；如果该 actor 正运行，排在它当前轮次之后。
python $bridge --state $state resume --actor a_接收者 --prompt-file 'C:\任务目录\续轮.txt'

# Devin 内部父会话或同级在确实需要对方回复时使用；未读消息会从当前工具调用返回。Codex 主控无事直接 idle。
python $bridge --state $state wait --self a_父 --actor a_子 --timeout 600
python $bridge --state $state inbox --participant a_父 --read

# 报告与验收分开。报告允许多个 --artifact（必须是现存文件）。
python $bridge --state $state report --from a_执行者 --to codex --summary-file 'C:\任务目录\结果.txt' --artifact 'C:\任务目录\产物一.txt' --artifact 'C:\任务目录\产物二.txt'
python $bridge --state $state reports --participant codex
python $bridge --state $state review --report r_报告ID --by codex --decision accept --evidence-file 'C:\任务目录\实际核查.txt'
python $bridge --state $state review --report r_报告ID --by codex --decision revise --evidence-file 'C:\任务目录\反证与预期.txt'
```

`inbox` 默认只列未读，`--read` 把选中邮件标为已读而不启动模型，`--all` 查看历史。消息的 `created_at` 只证明保存；`read_at` 证明调用方读取；`offered_at` 证明某个模型轮次已把 action 放入提示词；`consumed_at` 只在该轮次经 Lite 报告成功（或显式 CLI 路径 exit 0 且导出核验）后写入。运行中可主动 `inbox --read`；这需要目标执行者实际调用，不能由发送方代认模型已看见。`note` 不会自动续轮，避免确认回路。`action` 在目标已运行时排队；首轮失败且尚无真实 session ID 时保持队列并报错，不创建新会话冒充恢复。

收到 `report` 时桥梁生成一条普通邮箱通知；`submitted` 与 `accepted` 独立。`review revise` 把反证写入 action，交还原 actor 的原 session，后续报告版本号递增。接受者必须先独立检查需要自己验收的产物，再把证据写入 `--evidence-file`；普通任务也可按授权由 SWE/同级完成接受。`codex` 默认是外部参与者的持久邮箱和报告入口；仅配置现有聊天 UUID 并明确使用 `send --direct`、`report --final` 或 `block` 时，桥梁才调用宿主发信。它不通过 Devin 账户调用 GPT-6。Devin 可以报告需 GPT-6 多模态验收的请求，由原 Codex 聊天收到事件后实际路由。

## 纳入已有会话、占用、恢复、取消

```powershell
# 现有 attach 命令仍需该会话已有原生 CLI 导出作为 session/model 证据；Lite 新建会话可直接用桥梁 start。
python $bridge --state $state attach --from codex --name '已有执行者' --cwd '<该会话创建时的原始工作区>' --session-id '准确的 Devin session ID' --export 'C:\已有导出.json' --occupied

# --occupied 使动作排队而不抢占已有会话。确认外部运行结束后显式放行。
python $bridge --state $state activate --actor a_已有执行者
python $bridge --state $state cancel --actor a_执行者
python $bridge --state $state recover --actor a_执行者
```

`attach` 不复制或删除原会话；`--occupied` 表示调用方知道它在桥梁外被占用。若省略该标志，调用方承担已确认空闲的前提；桥梁无法为别的程序施加同一数据库锁。Lite `session/load` 报占用或恢复失败时该轮失败并保留准确 ID、状态和未消费消息。`activate` 只在调用方确认目标可续做后恢复排队。当前 `attach` 的旧导出要求属于兼容限制，不能用 Lite 的“已选模型”记录伪造原生导出。

默认 Lite 路径不拥有 ACP 进程，`cancel` 不能按进程名终止它，也不能在同一 session 可能有 GUI 插话时贸然发会话级 ACP cancel。取消桥梁监视时状态会明确提示检查该 host turn 是否仍在运行；须在 Lite 中确认实际结果后再恢复，绝不自动重放。历史独立 CLI 任务由原 runner 按准确 actor 收尾；新版桥梁不会新建此类任务。runner 异常消失时 `recover` 核对 PID/创建时间并标记结果不确定；先检查 Lite 会话、产物和本轮记录，再对已验证的原 session 续跑。正式会话默认保留。

## 状态与架构索引

全局入口是 Devin Lite 的单个 ACP 宿主；本桥梁作为协作入口调用它。ACP 驱动是独立诊断入口。一个任务目录下的 `bridge.sqlite3` 是注册、轮次、消息和验收的真源（SQLite WAL；单条变更用 IMMEDIATE 事务）。`turns/<turn-id>/` 存提示词、Lite host turn ID、状态记录、ACP 配置证据和 stdout/stderr；`runners/` 存后台 runner 日志。状态目录不是凭据仓库。

| 架构域/模块 | 流向与职责 | 实现索引 |
|---|---|---|
| 注册与发现 | `init/start/attach` → `actors` → `participants/status`；桥梁 actor ID 与原生 session ID 分开 | `init`, `make_actor`, `attach`, `participants`, `status` |
| 邮箱与排队 | `send` → `messages`；action 同事务建 `turns`；主动收信与自动边界续轮分开 | `send`, `inbox`, `enqueue_resume`, `wait_event` |
| 单宿主执行 | 每 actor 独立 runner → Lite HTTP → 同一 ACP 中的新会话/续轮 → 状态；同 actor 只有一个 token | `spawn_runner`, `runner_loop`, `run_lite_turn`, `lite_request` |
| 全局容量准入 | 每轮发给 Lite 前 → 本机实际会话＋归档 busy 会话＋已登记subagent去重 → 跨任务锁 → Lite 保留 busy 后释放锁；满额300秒后重查 | `scripts/swe_capacity.py` 的 `snapshot`, `summarize`, `admission_lock`, `admit`；每轮`capacity.json`；subagent登记见 `swe_subagents.py` |
| 报告验收 | `report` → 版本和通知；`review` → 接受或带反证原会话返工 | `report`, `reports`, `review` |
| 故障与生命周期 | Lite 状态丢失和 runner 对账、人工恢复 | `cancel`, `recover`, `activate`, `proc_birth` |
| 主控事件路由 | 显式 direct 消息/最终报告/真实阻塞 → 持久事件 → Codex 宿主 pipe 的 `send_message_to_thread` → 原聊天接收确认 | `send`, `new_wake`, `dispatch_wake`, `host_send`, `send_event_to_codex_host`, `wake_ack` |

调度没有固定树形；模型启动执行[全局并发准入](../SKILL.md#swe-并发准入与满额等待)。`swe_capacity.py`在每次 Lite turn start 前跨任务加锁，按实际会话与已登记 subagent 去重计数；满额的 actor/turn 为 `waiting_capacity`，300 秒后重查，`turns/<ID>/capacity.json` 保存准入证据。任何注册参与者都可成为组织者，有名额且职责不重叠时并行。桥梁不强制 OS 写入隔离，仍须明确共享文件与构建归属。父会话等待新子任务也占模型名额，应自行处理或释放自身轮次，不能用无限等待制造死锁。同一状态库里 session 唯一且每 actor 只有一个 runner；跨库容量锁不等于同一 session 的排他锁，纳入外部会话仍须确认占用并用 `--occupied` 排队。
