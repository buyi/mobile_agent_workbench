# M0 真实任务联调

本实验将持久任务、OpenCode、专用 Worker、Supervisor、独立 signer 和结果回写连接起来。目标是修复独立 fixture 中 `sumEvenThrough` 的边界错误，不修改 Loopit 业务代码。实验任务通过不代表 M0 里程碑通过，也不代表 M1 诊断页完成。


## 当前实际结果（2026-10-09）

固定代码实验已通过：`run-46a51a51-d1ce-45f2-83f6-719cc4fc2bb8`。OpenCode 将目标循环从 `< n` 修改为 `<= n`；独立 UID 421 验收器实测 12 个用例全部通过，父控制器核对 Ed25519 签名、实际证据字节、候选/Goal/Run/测试绑定和 Gate，随后通过正式命令将任务置为 succeeded。事件回放与当前状态一致。

实际证据目录为 `.bench/m0-fixes/control-loop-actual/code-task-passed`：`reports/result.json`、`reports/signed-check.json`、`reports/verification-evidence.json`、`reports/repair-admission.json`、`reports/recovered-context.json` 和外层 `status.json`。外层报告确认 Worker 与 Signer 的进程和专用 launchd 域均清空，临时 access-only 副本已删除。公钥和旧预留归档证明已只读导出，未导出私钥。

成功 Run 观测到 5 个模型步骤、原生报告 14,583 tokens；美元费用仍 unknown。此前失败 Run 及其日志完整保留，其中一次派发回执不明确的 Run 保留 usage=unknown，不能将可见 token 简单求和宣称全实验用量完整。原截止 `2026-10-09T11:08:25.455Z` 未改变；最终 repairIndex=2，未超过最多三次修复。

计量补充见 `.bench/m0-fixes/control-loop-actual/run-metrics-audit.json`，可用 `script/m0/audit-run-metrics.py` 对只读导出重建。成功 Run 的四次工具操作原生报告合计 96 ms，独立验证器证据区间 855 ms；这些区间不代表全部模型推理耗时。队列与纯推理没有独立边界，保持 unknown。Run 中 `humanInterventions=0` 只涵盖已入账计数，没有计入本次基础设施排错、管理员认证及先前目标确认，不能据此声称整个 M0 建设无人介入；完整介入计量仍需补齐。

| 独立实验 | 已实际验证 | 仍不代表 |
| --- | --- | --- |
| 代码修复主链路 | Task/Run → OpenCode → Worker 停止 → 独立验收/签名 → 状态回写/回放 | 完整 M0、移动端业务功能、通用常驻执行服务 |
| Signer 正负对照 | 正确/错误代码、缺失候选、错误摘要/Run、调用者公钥、重复请求、签名篡改共 8 组 | 所有 M0 证据类型、跨机器部署证明 |
| iOS 安装协议 | 固定模拟器安装一次；丢回执/查询不可用不重装；实际包字节核对；清理隔离后卸载关机 | OS 层设备独占、正式交付 Run 与签名 Gate 绑定 |

M0 仍为 blocked。独立 RecoveryJournal 主机/存储未配置；设备 Broker 尚无 OS 层独占；真实暂停/取消/重启故障矩阵、阶段验收签发接线、完整 M1 输入与整组 M0 证据仍须收口。诊断信息页尚未实施。

## 责任边界

OpenCode 负责模型推理、读文件和编辑循环；本项目不再实现一套 Agent 推理循环。`packages/runtime` 只固定版本、权限、身份、预算并转换原生进程事件。`packages/delivery` 负责命令回执、任务状态、事务事件、Outbox 和上下文重建。

`worker-supervisor.py` 独占专用 UID、记录 generation 和启动截止时间。启动器持共享门禁直到完全降权；停止方先取得独占门禁、撤销启动许可，移除该专用账户的 launchd user 域，再同时核对域与所有专用 UID 进程。域目录从 `launchctl print system` 的 `subdomains` 读取，避免 `print user/UID` 隐式新建后台域。旧 scope、旧 generation、错误阶段和身份漂移均拒绝。进程组外的 `setsid` 后代也属于核对范围。回收子进程先完全降权，再逐一处理本轮扫描到的 PID；不使用全体或进程组广播信号，PID 已退出则重新观察，其他错误保持隔离。停止证明明确不涵盖设备或远端副作用。

`packages/verifier` 由 UID 421 签发，模型使用 UID 420。固定测试与签名密钥不由候选指定。每个输入在新的受限子进程中执行，signer 父进程比较观察值；通过后先保存证据，再签署候选、目标、验收、Run、测试与 Gate 的绑定。它目前仅支持这个有限的纯函数实验。

## 顺序与产物

1. `prepare-control-loop.ts` 创建真实 Git fixture 基线、冻结目标与文件摘要，打包控制器、验收器和进程探针，不读取凭据。
2. `install-control-loop.py` 默认审计；显式管理员执行才安装固定文件、生成专用签名密钥并构造短期 access-only 副本。原 OAuth 存储和 refresh token 不改动。
3. `supervisor-probe.ts` 先验证身份正例和门禁负例，再留下专用 Worker 及脱离原进程组的后代。Supervisor 清理后，探针核对停止证明和拒绝迟到启动。
4. `control-loop.ts` 通过真实 Delivery 命令创建 Task/Run、消费 Outbox、启动固定 OpenCode。绝对截止时间为 60 分钟，最多允许 3 次修复；当前首跑从 repairIndex 0 开始，不会根据模型文本自动续期。
5. Supervisor 停止 Worker 后才进入验收。控制器检查整个工作区仅允许目标文件改变，signer 分别验证已知错误、已知正确及实际候选。
6. 控制器验签、核对证据文件实际字节和 Gate，重读数据库及实际产物重建上下文、统计原生 token 事件、保存候选经验，再报告任务终态并核对事件回放。

主要报告位于安装目录的 `control/reports`：`supervisor-probe.json`、`account-boundaries-<scope>.json`、`execution.json`、`workspace-boundary.json`、`verifier-controls.json`、`signed-check.json`、`recovered-context.json`、`experience-candidate.json`、`result.json`。`result.json` 中 `milestonePassed` 和 `m1FeatureImplemented` 均固定为 false。

费用保持 `unknown`；原生 token 事件去重统计，不能把套餐登录的 reportedCost=0 当成美元费用为零。经验只是带版本、作用域、来源与有效期的候选产物，不会自动改变策略。

## 安装修正与真实故障

首次无模型部署暴露了 macOS 身份检查差异：现代 Python `os.getgroups()` 与 `id -G` 返回目录成员信息，本机实际结果包含通用账户组；传统 libc `getgroups` 读取的进程内核组仅为 420。启动器、回收进程和 Runtime 改为核对真实内核组，仍要求恰好为目标 GID，没有放宽额外组权限。Worker 内部身份探测使用锁定 Bun 的 `bun:ffi`，避免 `/usr/bin/python3` shim 隐式启动 Xcode 工具。相关语义见 [Python 官方文档](https://docs.python.org/3/library/os.html#os.getgroups)。

`update-control-loop.py` 是这次固定 M0 安装的有限修复入口，只能更新五个已登记代码资产；校验旧/新摘要、持有两把门禁锁、保留旧文件及回执，更新中保持 maintenance 禁止派发。它不修改 Goal、源码、预算、账户、signer 配置或密钥。失败安装、失败探针和修正记录应一并保留，不能覆盖成成功历史。

独立恢复存储、设备 Broker、渠道结果核对与完整 M0-A01–A15 仍须各自提供实际证据；本实验的本机进程证明和小任务签名不能替代这些要求。

第二次真实部署探针已拒绝 Python shim 超时；回收后发现专用账户的 launchd 服务会重新启动。独立清理实验已实际删除 UID 420 的 user 域，并通过五次无副作用的域目录与进程清单复核；UID 421 同时为空。首次直接查询 `user/420` 造成域重建的失败记录一并保留，不能算作清理成功。正式 Supervisor 的合并部署结果另行记录。

第三次无模型探针已真实观察到 Worker leader 与 `setsid` 后代，并通过 Bun 身份和门禁检查。强制清理时，非特权 `kill(-1, SIGKILL)` 在本机实测使回收子进程自身以信号 9 退出；Supervisor 因而保留 stopping，未调用模型。随后独立诊断确认专用 UID 为空，并通过正式 recover 得到域与进程均已清空的证明，移除该探针文件和短期 access 副本。该行为以实际退出状态为准，不能从手册文字推断回收子进程必定存活。

第四次部署中 Supervisor 探针正式通过（generation 5）：观察到专用 UID 的 leader 和 `setsid` 后代，强制回收后核对域与进程为空，迟到启动和旧 generation 均拒绝，探针文件已清理。随后真实控制器在模型调用前的账户检查中因使用不存在的 `/usr/bin/test` 失败；现已修为本机 `/bin/test` 并保留每次 scope 的独立诊断。原预算截止时间不重置。

账户 DAC 五项实测随后通过，但正式 Run 的 Runtime 准备阶段失败，因此只保留 queued Run 与 quarantined Dispatch，没有调用 startPrepared。独立 `runtime-preflight.ts` 使用同一专用身份、固定二进制和沙盒，已通过准备检查（generation 8）；它只使用非秘密占位值，不调用模型，也不证明真实 OAuth 凭据可用。Runtime 现为 pin/input/layout/identity/version/help/config/auth 分阶段保留无秘密诊断。

准备失败恢复仅适用于明确未派发的 quarantined reservation：旧 Run 仍 queued、旧 Worker/Signer 停止事实完整、候选仍是基线，才允许同一 Run 创建新的 Attempt。恢复授权摘要与旧记录必须持久保留，原 deadline、repairIndex 和 maxRepairs 不重置；任何可能已执行的状态继续隔离，不能套用此入口。此恢复入口的实际接通结果另行记录。


## 本次完成的接线修正

- OpenCode 会写固定 `.git/opencode` 项目标识；仅允许其字节严格等于受保护基线提交号，其余 Git 文件仍禁止修改。
- 三步模型上限在目录查找中耗尽，原候选未改；后续 Run 使用八步，文件权限仍严格限定为 `sumEvenThrough.ts`，没有放宽到目录或 Shell。
- macOS 拒绝嵌套 `sandbox_apply`。`--signer-verifier` 只允许固定 UID 421 在 finalizing 阶段运行 root 所有且摘要锁定的 Bun/Verifier，清除调用方环境注入；可信父进程不套外层沙盒，候选子进程继续使用严格 Seatbelt。真实正例和负例随后通过。
- 终态失败必须创建新 Run。`prepare-control-repair.py` 先核双账户停止事实、旧结果/Goal/预算/摘要，归档报告和旧配置，再更新 Run 绑定和修复计数；不重置截止时间，不修改密钥或数据库。部分发布失败保留 maintenance。
- 旧 Runtime 预留不会因 leader 退出自动消失。`releaseStoppedReservation` 接受上层已验证停止证明的授权，核对原 input/state/operation/reservation，先持久化授权再原子归档预留；原执行历史保留，同一授权重放不会释放后来的预留。未知启动单独保留失败与 unknown 用量，不能伪造“未调用模型”。


证据时效收口：`acceptSignedFixtureCheck` 在纯验签之上核对实际证据摘要、内部绑定以及由可信控制器提供的 Run 起点和原 deadline。真实签名在截止前按真实时钟复验通过；deadline+1ms、缺失、损坏和错误 Run 均拒绝。控制器时间窗守卫已于 11:10:17Z 通过固定资产更新器安装，没有复制认证或重跑模型。此次安装不是新的一次任务通过，旧通过报告仍绑定其实际执行时的控制器摘要。复验记录为 `.bench/m0-fixes/control-loop-actual/offline-verification-audit.json`，安装回执为 `evidence-time-window-installed.json`。
