---
name: devin-session-collaboration
description: Codex 与 Devin、以及 Devin 内部的自主会话通讯与协作；默认经 Devin Lite 的单个常驻 ACP 入口发布和续跑任务，桥梁保存邮箱、结果和验收记录。
---

# Devin 自主会话通讯

本技能提供各参与者共用的通讯方法。Codex、Devin 组织者和同级执行者在各自获授权的任务中，按职责独立性、并行收益和沟通成本主动判断是否发起分工、互相咨询或转交任务，无需用户再次点名“subagent”或“执行会话”；协作关系可动态改变，结果由相应接收者回收。模型职责遵循 [当前执行者策略](../codex-thread-communication/references/executor-policy.md)。

## 委派方式

Codex 有 Devin 名额时把 SWE-2 High 当作异步自主 subagent 使用，通过本桥梁调用已经运行的 Devin Lite，由 Lite 的单个 `devin acp` 承载会话；并发已满时按任务难度选择 GPT-6 Sol Max 或 GPT-6 Luna Max，具体路由见[当前执行者策略](../codex-thread-communication/references/executor-policy.md)。给 SWE 委派时简短提供目标、已知事实、可用材料和必要边界，由 SWE 自行决定实现路径；Luna 任务书按 [Codex 协作](../codex-thread-communication/SKILL.md) 给出明确方法和判据。Codex 轻量确认任务正常启动、无明显运行故障后即可放手；有其他独立工作照常推进，无事直接结束当前轮进入 idle，不持续监视、反复查询进度或阻塞等待。SWE 自主完成受委派职责，不设轻量模型式逐步检查或逐阶段报批；普通问题与获授权的同级自行解决，完成或真正需要主控处理时再回送。接收方可按分工是 Codex、Devin 同级或组织者，收到后按正常职责整合、验证和交付。

## 会话工作区与任务目录

桥梁 `start --cwd` 决定新会话记录的工作目录，Devin Lite 按此目录分组。发布者先识别稳定的项目根目录或独立 checkout 根目录，用它作为会话 cwd；同一项目下的任务书、`--state`、隔离工作目录与产物可以各在自己的任务区，用绝对路径交给执行者，并在任务书中规定写入归属。**任务隔离靠明确的文件范围和独立任务材料，不靠把每个任务子目录设成会话 cwd。**子目录本身是独立项目/checkout，或用户明确要单列工作区时才例外。`--cwd` 只是工作目录与会话归属，不是文件权限边界。任务正文经 Lite 作为 prompt 发送到该会话，不会成为工作区路径。

新会话发布前核对 cwd 与预期工作区名称；续跑或 `attach` 已有会话时使用其原始 cwd 和准确 session ID，不通过改 cwd 来迁移历史会话。若原会话确实建在错误目录，保留其上下文；需要转到项目根目录时另行明确交接到新会话，不静默重建或删除。命令示例见 [桥梁 CLI](references/bridge-cli.md)。

## SWE 并发准入与满额等待

用户规定 Devin 并发上限固定为 **5 条**。发布新执行者、普通续跑或 Devin 同级 action 触发下一轮，以及执行者自行派生任务前，都先检查当前实际运行总量；不能只数自己的任务库，也不能把历史会话数当运行数。**外部主控发给运行中的 Devin 会话的 action 是同会话插话**，直接通过 Lite 投递并单独追踪结果，不占一个新会话名额，也不等待普通队列；若目标会话尚未运行，仍须通过 Lite 的容量准入。`devin_bridge.py --state <任务状态目录> capacity` 返回 `active/limit/available`；`start` 自动预检并在结果中附带容量快照，满额时退出码 2、`admitted=false`，不创建 actor/turn。

按实际执行会话计数：同一单轮Devin CLI与其ACP子进程合并为一个；跨项目SWE也占名额。独立ACP可能同时承载多个会话，不能按一个进程只记一个名额。已识别的Devin Lite宿主按实际监听端口读取全部分页会话列表，以sessionId去重计入每个busy会话；模型未知的busy会话同样占位。未知独立ACP或宿主列表不可达、字段不完整、分页未结束时，保留诊断并停止派发，不能按零或一个放行。其它不能确认活跃度的单轮/交互CLI保守占位。此检查只能证明本机可观察的调用与宿主报告状态；账号另有远端执行时，将已知占用纳入判断。Web宿主自行派发不持有本桥梁的准入锁，快照不是对全账号并发的绝对保证。

会话内经 `run_subagent` 派生的 subagent **同样各占一个名额**（前台阻塞式与后台异步一样计）。已实测确认：subagent 不产生独立 `devin` 进程、`sessions.db` 会话行或 `/api/sessions` 条目，外部无法枚举，因此实行**派生方自报**：调用 `run_subagent` **之前**先运行 `python scripts/swe_subagents.py reserve --parent <自己的session/actor> --title <任务>`，该命令在全局准入锁内检查并登记，返回 `active_after/limit/available_after` 与 `reservation_id`。仅 `admitted=true` 才能启动；满额退出码 2 时由 Devin 当前会话自己执行，不转给 Codex，不排队派生。启动失败或子代理完成后立即 `done --agent <reservation_id>`；长时运行期间用 `heartbeat --agent <reservation_id>` 保活。旧 `register` 仅供已运行子代理的存量登记，不可作为新建前的预留。登记项带 `host_pid` 时宿主进程已死即不计；超过 `DEVIN_SWE_SUBAGENT_TTL`（默认6小时）未保活视为残留不计入但保留待 `sweep` 清理。不可观测不等于不占名额：禁止以不登记绕过上限。

达到上限或新增后将超限，桥梁持久保留已提交的待执行任务并进入`waiting_capacity`。后台执行器**每300秒（5分钟）重新查询运行总量**，有空位时在全局准入锁内重查并启动；没有空位继续等，不能超发或终止他人的任务。等待期间可响应取消，但取消检查不额外轮询容量。查运行数与启动须为同一跨任务互斥操作，避免多个发布者同时占同一空位。Codex 为新任务选择执行者时，在提交前按上限检查；已满则按任务难度选择 GPT-6 Sol Max 或 GPT-6 Luna Max，不创建等位的 Devin 执行者。发现已超限时停止新增，等待自然释放。

这是已提交 Devin 任务的异步容量调度，只轮询名额，不高频检查模型进度；Codex 新委派在预检满额时按任务难度选择 GPT-6 Sol Max 或 GPT-6 Luna Max。对仍在桥梁等位的任务，后台队列负责5分钟复查。父会话需新子任务而无名额时，自行处理或保存状态后释放自身执行轮，避免名额全被等待子任务的父会话占满。

普通桥梁回合启动前调用 `scripts/swe_capacity.py`，固定上限 5；本机用户 LocalAppData 下的全局锁跨任务库共享。Lite 路径在锁内调用 `/api/bridge/turn/start`，响应前 Lite 已保留 busy 计数，后续准入扫描将该会话计入；扫描包含归档中仍运行的会话。Lite 的网页发送、主控插话和手动重试也在服务端检查上限；同一运行中会话的插话不新增名额，容量未知时停止新会话派发。每轮 `capacity.json` 记录数量、上限、检查时间及满额时的下次检查时间。只读预检可用桥梁 `capacity` 命令或容量脚本；普通派发仍在锁内重查。已有会话的外部主控 action 走桥梁 `__inject` 直投，不会启动另一个模型进程；不要靠直接启动模型或不登记 subagent 规避名额。

Devin Lite（`D:\devin-lite`）的网页主动消息和已有会话的外部主控 action 直接尝试投递；若后端拒绝，在原消息/桥梁 turn 上报告失败，不暗中排队。普通桥梁回合遇到并发/配额拒绝时进入延期队列，错误携带秒/分钟/小时或结构化期限时按 `期限+5s` 定时重发，最少等待 30 秒；无明确期限时按 30 秒容量复查节奏。网页默认展开所有 Lite 延期项，可逐条查看全文、手动重试或取消；接口为 `GET /api/queue|queue/item`、`POST /api/queue/send|drop`、`GET /api/capacity`。这只显示已经进入 Lite 的延期项；桥梁仍在 5 分钟容量等待中的普通回合记录在对应任务库的 `waiting_capacity`。该队列不持有全局准入锁，普通桥梁派发仍走锁内准入。

## 选择入口

- 日常多会话协作使用本技能 `scripts/devin_bridge.py`；只允许 `DEVIN_BRIDGE_TRANSPORT=lite`，连接本机 `http://127.0.0.1:8317`（可由 `DEVIN_BRIDGE_LITE_URL` 指定本机端口）。Lite 不可达时明确失败并保留任务状态，不悄悄另启一套 Devin。具体操作见 [桥梁 CLI](references/bridge-cli.md)，状态与投递语义见 [桥梁契约](references/bridge-contract.md)。派单会给 Devin 执行者提供同一入口、任务 ID、关联参与者和使用示例，内部通讯无需经 Codex 逐条中转。
- 原生 CLI 的 `--help`、模型目录与会话列表可用于只读诊断；协作模型回合一律通过桥梁和 Lite。旧 `DEVIN_BRIDGE_TRANSPORT=cli` 已禁用，若发现历史独立回合仍占锁，按准确 actor 取消或等待其结束，再由 Lite 装载原会话；不要按进程名全局清理。
- 只有调用方需要 ACP 结构化协议时，使用 [ACP 驱动](../devin-acp-driver/SKILL.md)。ACP 不是直接 CLI 的前置依赖。

## 原生 CLI 的事实与命令

本机 PATH 上的 `devin` 是独立 CLI。先用 `Get-Command devin`、`devin --version`、`devin --help` 核对当前接口。账号可用性用 `devin auth status` 与 `devin models list --format json` 检查；模型目录只读取目标 `family_uid` / `model_uid`，不因名称包含 swe-2 就选中 Fusion 等其他产品。不要打印或复制凭据。

2026-09-26 当前 CLI 3000.11.1 已识别现有 Devin 登录，并公开 `--print`、`--prompt-file`、`--model`、`--resume`、`--export`。旧版“必须 ACP、直接 CLI 不认 Desktop 登录”的断言不再作为路由依据；换环境时以当前返回值为准。

```powershell
# 在稳定的项目或独立 checkout 根目录执行；任务书可放在任务子目录。
devin --model swe-2-high --permission-mode dangerous --respect-workspace-trust false `
  --prompt-file '<任务书绝对路径>' --export '<本轮导出绝对路径>' --print

# 按已确认的精确 session ID 续跑；每轮使用独立导出和日志。
devin --model swe-2-high --permission-mode dangerous --respect-workspace-trust false `
  --resume '<session-id>' --prompt-file '<续跑任务书绝对路径>' `
  --export '<续轮导出绝对路径>' --print

# 当前 cwd 的会话发现：
devin list --format json
```

`dangerous` 是该 CLI 的无人值守权限模式；仅在已授权的任务与 cwd 使用。`--respect-workspace-trust false` 解决非交互模式无法展示目录信任确认的问题，不扩大任务授权。不修改用户全局信任或登录设置。进程使用参数数组，长任务书通过文件传递，输出按 UTF-8 保存。后台启动隐藏窗口。

`High` 已编码在 `swe-2-high` 中。检查进程继承的 `DEVIN_REFUSAL_FALLBACK` 等可能换模型的配置，隔离当前调用，不改全局环境。模型证据取实际会话记录/导出或协议，不采用模型对自身身份的回答。CLI 退出 0 与“实际成果满足任务”是不同结论。

## 状态、消息与续跑

每个参与者有稳定桥梁 ID，对应真实 Devin session ID、cwd、任务书、运行记录和结果。正常完成后保留 session，后续按精确 ID 继续；并行任务不使用 `--continue` 猜最近会话。

默认运行中会话由 Lite 的单个 ACP 进程持有，桥梁 runner 只通过本机 HTTP 发起回合并长等状态，不再各启动一个 `devin --print`。**SWE→SWE 通信默认用普通 `send`**：它立即写入接收方邮箱，不建立下一轮 `turn`。若接收方本轮正通过 `wait --self <自己> --actor <发送者>` 等待，桥梁在最多约一秒的查询间隔后把未读消息直接作为该工具调用结果返回，接收方随即用 `inbox --read` 标记已读并继续当前轮；若接收方正忙于别的模型生成或工具调用，则在它下一次主动读邮箱时进入上下文。Devin 同级的 `send --action` 建立后续任务，目标当前轮结束后由原 session 续做；**外部主控对已有会话的 `send --action` 直接经 Lite 发起独立插话回合**，不等 actor 普通 runner 结束。已保存、已读取、已交给模型、已执行分别记录；即时到达邮箱或 ACP 接受请求不等于正在生成的模型已收到。GUI 的插话直接走同一 ACP session 的 prompt 入口；桥梁邮箱 `send` 仍维持协作消息语义。

**当前没有经验证的模型级 `session/inject` 能力。**Lite 允许把新 prompt 立即发给同一 ACP session，前端按独立消息呈现；这证明已投递请求，不证明它打断了正在生成的模型，也不保证模型何时应用。桥梁普通 `send` 仍只写邮箱；需要接收者当轮回应的同级咨询，配合 `wait` 或 `inbox --read`。需要接收者之后独立执行则发 `--action`。原生 CLI 的 `--resume` / ACP `session/prompt` 是轮次路径；再开一个进程抢占同一 session 不是直达。找不到目标或模型/认证不符时明确报错，不无上下文新建来冒充续跑。

将来若 Devin 明确提供程序化运行中注入，先核对本机版本的 CLI/ACP 能力声明，再按消息 ID 区分接受、送达与实际应用。仅看到协议草案、可输入的交互界面或 `session/prompt` 不满足升级门；缺能力时保持上述合作式邮箱路径。依据：[Devin CLI 命令参考](https://docs.devin.ai/cli/reference/commands)、[Devin CLI 交互队列更新](https://docs.devin.ai/cli/changelog/stable)、[ACP v1 会话流程](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)、[ACP `session/inject` 提案](https://github.com/agentclientprotocol/agent-client-protocol/pull/2043)。

父会话和同级可直接收结果。等待期间保持邮箱可用；并行调度考虑等待者和子任务的依赖，避免占满槽位后彼此永远等候。任务彼此不重叠时可同 cwd 工作；重叠写入或共享编辑器、端口、构建产物时约定归属或隔离。

回送 Codex 原聊天使用任务绑定的 UUID 与宿主 `codex_app/send_message_to_thread`。`send --direct`、`report --final`、`block` 先持久化事件；Devin 侧创建的事件由持有 app-tools pipe 的 Codex 桥梁 runner 投递，Codex 侧直接执行命令且已有 pipe 时可同步投递。Devin Lite 持有的 ACP 进程没有继承 Codex pipe，因此 Devin 侧命令只落盘，不直接调用宿主。不再走 `codex queue`，直达失败也不静默排队或反复重试。`--direct` 只用于确需主控当前处理的协作消息，普通 `send` / 不带 `--final` 的 `report` 只进 Codex 持久邮箱。宿主已接受、原聊天实际可见、模型已处理是不同状态；首次实战仍须确认后两层。后台程序只做持久化、筛选、去重和投递；普通消息及中间报告不自动启动 GPT-6。完整职责策略见 [Codex 协作](../codex-thread-communication/SKILL.md)。

当前直达覆盖 **SWE → 原 Codex 聊天** 的显式 direct 消息、最终报告和真实阻塞：桥梁只构造固定工具名与任务绑定的目标线程，不提供任意宿主工具调用命令。Codex 启动 runner 时须继承 `CODEX_APP_TOOLS_PIPE_PATH`；该路径不交给 Devin ACP，也不写入任务状态。runner 每次只尝试自身启动后新增的事件一次；旧 `pending`、宿主拒绝后的 `pending` 及结果不明的 `attempting` 不自动重发。没有可用 Codex runner 时事件留在邮箱，可查 `wake-status` 并由主控显式 `wake-retry`。SWE → SWE 的当前轮自动注入仍需要 Devin 版本明确支持的运行中接口；现役邮箱主动读取与下一轮 action 不能冒充该能力。当前边界和命令以 [桥梁 CLI](references/bridge-cli.md) 为准。

## 接受、返工与恢复

执行者报告改动、证据和未决项。执行完成、自检、独立接受和用户接受分别记录；按任务需要由指定接收者读实际产物并核对后接受，没有独立验收者时保留“自检完成”的真实状态。有反证则连同预期效果发回原会话，让执行者自主修到结束。内部咨询不设置审批门；需要多模态实战验收或动画/特效制作时路由 GPT-6。

进程失败、取消、占用和重启保留可恢复的任务/消息状态。Lite 重启后旧 host turn ID 若消失，桥梁将该轮视作结果不确定，须先查看会话和产物再决定是否续跑，不能自动重复任务。桥梁只请求取消自己记录的 host turn，不按进程名关闭共享 ACP。正式工作会话保留；纯探针会话保存必要导出后可由创建者执行 `devin rm <准确session-id> --force`，该命令不可恢复，不用于清理他人会话。

与实际任务无关的会话历史/文件归因调查不属于本技能的默认动作。需要明确历史取证时按用户授权另外处理。

## 实战维护

后续由使用本流程的实战会话**根据需要动态维护**本 SKILL、直接引用和桥梁程序。遇到实际接口、协作方式或运行条件变化时，修正现役正文与必要实现，按影响验证并记录真实能力边界；不把本次测试状态当永久规则，不维持无人需要的测试或轮询任务。
