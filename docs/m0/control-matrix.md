# M0 A05/A06 控制矩阵

本实验使用固定的无模型长进程，连接真实 Delivery、WorkerDispatch、SQLite、受限 Runtime 和 macOS Supervisor。它验证暂停、冷恢复、显式恢复和取消的控制协议；不把 fixture 运行当作 OpenCode 模型交付，不改变已完成的模型 Run。

## 生产接口

`WorkerDispatch.confirmStopped(runId, authorization)` 只接受当前已提交的 `pauseRun` 或 `cancelRun` 事件。Runtime 必须有完整的持久退出观察，可信宿主 `verifyStopped` 必须返回绑定 exact Attempt、控制事件和双 UID 独立停止证明的授权。缺少端口、持久退出观察或证明时，Run 保持 `pausing` / `cancelling`。

`WorkerDispatch.resumeStopped(runId, authorization)` 必须找到实际已提交的 `resumeRun` 回执、该 Attempt 的已验证暂停记录和匹配的 Runtime 预留释放摘要。它生成新 Attempt、Operation、Execution 和 Context 身份；绝对 deadline、repairIndex、maxRepairs、权限和原目标保持不变。准备完成后重新检查宿主授权，再在短事务内核对当前控制事件并启动。并发取消不会被恢复覆盖；准备失败持久隔离，冷启动不重派。

`controlHistory(runId)` 返回只追加的停止/恢复历史。相同 nonce 精确重放不会再次执行；不同请求不能重复使用 nonce。原 Runtime reservation 只由可信控制器在独立核对后调用 `releaseStoppedReservation` 精确归档，`safeToRedispatch` 不会被改为 true。

这些接口只验证和记录可信宿主提供的绑定，不能自行证明操作系统已停止。Runtime 的冷态 ownership 为 unknown；只有持久完整退出记录加独立 OS 停止证明才可继续，缺失或仍在运行的记录仍拒绝。

## 本机部署流程

1. 普通用户运行 `script/m0/prepare-control-matrix.ts --out <新目录> --protected-run <已完成 Run 的 root job 目录>`，生成包和 `manifest.json`。摘要从 root 已导出的 `/private/var/loopit/verifier-deployment-export` 读取，安装后的 controller 只校验原 root job 的受保护文件。staging 创建仅含 fixture.txt 的真实 Git 提交，将真实提交 ID 冻结到 Goal，并将全部 Git 文件/目录按 Worker 0600/0700 列入 manifest，没有 hooks。此命令没有管理员、模型、网络或设备操作。
2. 管理员审阅并按 manifest 精确摘要/UID/GID/mode 安装到独立 `finalRoot`。`control` 是 root 私有，`workspace` 与 `runtime` 是 UID420 私有；不修改账户、原模型 Run、signer 配置或既有预算。
3. 按 manifest 的 `invokeTwice` 参数运行一次现有 Supervisor。controller 创建独立任务和 Run、启动 fixture、提交正式 pause、通过 drain 停止本地 child；此时仍为 pausing。Supervisor 关闭入场并独立停止 UID420 和 UID421，finalizer 才调用 confirmStopped，落盘 paused 并冷读复核。
4. 首次成功后再次运行相同 Supervisor 命令。冷态首先读到 paused；真实 resume 命令后缺少证明的请求必须拒绝且没有新 writer。核对紧邻前一 Supervisor scope 的双 UID 证明，精确归档原 reservation，再调用 resumeStopped，生成第二 Attempt。正式 cancel 经 drain 后保持 cancelling，只有第二轮独立停止证明到达后才变为 cancelled，并冷读复核。
5. Supervisor 返回 stopped，检查两个 `*-finalized.json`、两份 `cold-read-*`、scope stop proofs、不可变 controlHistory 和原 Run 三份证据的 before/after pins。任何阶段失败都保留现场并停止，不重复运行以绕过隔离。

预算在首次 execute 时冻结为独立 **10 分钟、repairIndex=0、最多 3 次 repair**；实验不执行 repair，第二 scope 沿用原 deadline。每次 Supervisor 另有 120 秒上限。原成功模型 Run 的 result、execution 和 execution-budget 文件先验证 root 路径保护，再在每阶段核对摘要，旧 Run 不发生写入。

## 验证状态

2026-10-09 11:50 UTC，`m0-control-matrix-20261009-f` 已在真实 UID420 Worker / UID421 signer 的 Supervisor 边界完成两轮部署实验。独立审计 [independent-audit.json](../../.bench/m0-fixes/control-matrix-actual/independent-audit.json) 的 **83 项检查全部通过**；原始报告保存在 [passed-f](../../.bench/m0-fixes/control-matrix-actual/passed-f)。此审计只读检查报告、原始字节和绑定，没有再次执行管理员操作或把本地报告当作独立签名 Gate。

| 实验 | Supervisor scope / generation | 实际结果 |
| --- | --- | --- |
| 暂停 | `4ff8aa19-4d47-432f-b9e0-4309eac037f0` / 16 | PID94039 真实执行；正式 pause 后保持 pausing；双 UID 停止且 user 域为空后变为 paused，关闭并重新打开 SQLite 仍 paused |
| 冷恢复后取消 | `2f6fe0de-526c-41c9-891e-2d6a96663b6d` / 17 | 同 Run 从 paused 显式 resume，新 Attempt / Operation / Execution / Context；PID94345 真实执行；正式 cancel 后保持 cancelling，双 UID 停止证明后 cancelled，冷读仍 cancelled |

两轮共享 Run `run-a224b313-3740-4c4d-be10-2a4b083fe5c9`。冻结预算始终为 `deadlineAt=2026-10-09T12:00:07.535Z`、`repairIndex=0`、`maxRepairs=3`，没有刷新或使用旧模型任务的预算。不可变历史完整保留 stop → resume → stop，原模型 Run 的 result、execution、execution-budget 三份摘要一致。第二轮真实提交 resume 后，故障注入到可信宿主证明端口，确实拒绝了新 Attempt、prepare 和 writer；解除故障并精确释放原预留后才执行正例。

普通权限回归的生产控制面另有 **88 tests / 0 fail**，包括证明在 preparation 期间被撤销、controlHistory 写入失败时整个 SQLite 事务回滚、旧 PID 文件和读取中退出等负例。原 `-d` 因 fixture 误读已被 launcher 删除的 scope 环境变量而失败，原始诊断保留；`-e` 安装但未执行。修复后的 `-f` 保留 launcher 隔离，以当前 Runtime PID、派发前文件集合和新鲜时间窗绑定回执。

这证明了 **A05 暂停/恢复/取消控制矩阵的部署切片**，以及 A06 的正常停止后冷读与拒绝缺证明恢复。**完整 A06 仍为 partial**：controller 被杀、旧 UID420 child 仍存活时的 unknown-owner 冷恢复窗口尚未由本矩阵实测。完整 M0 和交付 Gate 仍不能据此宣布通过。

缺证明负例发生在真实 resumeRun 已提交之后、Runtime 预留释放之前：可信宿主 verifyStopped 端口明确注入不可用，检查旧 Attempt 未替换、prepare 未调用、没有本 scope 的进程回执。随后解除故障、核对真实证明、释放旧预留，才执行恢复正例。本矩阵只做正常退出后的冷启动，尚不覆盖 controller 被杀且旧进程存活/未知的全部 A06 窗口。

本实验的 CLI 可执行文件是固定的 **unbilled fixture**：只回答版本、帮助、有效配置探测并运行等待信号的长进程，没有模型 SDK、网络客户端、设备操作或真实凭证。它走与 OpenCode 相同的受限 Runtime 适配入口；此前真实 OpenCode 模型编辑证据应单独引用。

fixture 不读取 launcher 已删除的 scope/generation。controller 在派发前记录既有 PID 回执文件集合；若当前 PID 碰上旧文件，直接拒绝，既不删除也不重用。回执还必须在本次派发时间窗创建，并在有界读取前后均匹配同一 local/running Runtime handle、请求摘要和活进程。root 报告保存回执摘要、文件时间与绑定。这个检查证明固定 fixture 的本次输入回执，不把 PID 本身当作安全的恢复身份。
