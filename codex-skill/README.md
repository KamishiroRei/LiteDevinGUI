# Codex 协作入口

`devin-session-collaboration/` 是本仓库可追踪的协作手册与桥梁程序，`codex-thread-communication/` 是 Codex 执行者路由手册。当前本机安装目录为 `C:\Users\ASUS\.codex\skills\` 下的同名目录；本次已将两处内容同步。安装到其他电脑时，将这两个目录复制到该电脑的 Codex skills 目录，并保持 `scripts/`、`references/` 的相对结构。

桥梁只连接运行中的 Devin Lite（`http://127.0.0.1:8317`），不另开 Devin 模型进程。`DEVIN_BRIDGE_LITE_URL` 可指定同一个单宿主的其他本机端口；旧 `DEVIN_BRIDGE_TRANSPORT=cli` 会明确报错。任务书正文是 prompt，`--cwd` 是项目或独立 checkout 根目录。

新建前用 `devin_bridge.py --state <目录> capacity` 查看 `active/limit/available`；`start` 也自动预检，固定上限 10。Devin 内部调用 `run_subagent` 前用 `swe_subagents.py reserve` 预留，满额时自己执行，不回流给 Codex；完成后用 `done` 释放。

执行 `python -m unittest discover -s codex-skill/devin-session-collaboration/tests -v` 可运行不启动真实 Devin 的桥梁契约检查。仓库的 `codex-thread-communication/` 仅镜像这次改动的现役入口与执行者策略；安装环境中的其他历史参考文件仍由本机技能管理。
