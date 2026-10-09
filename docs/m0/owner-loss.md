# M0 A06：controller 丢失后的实际隔离实验

这是与已通过的暂停/取消矩阵分开的新任务、Run、SQLite 和 Runtime 状态目录。只运行固定的无模型 fixture，仍使用专用 UID420/421 和现有 Supervisor。旧模型任务及 `-f` 的证据不发生写入。

第一次 Supervisor scope 的有限父 controller 启动自己持有的子 controller。子 controller 通过真实 Delivery `drainOutbox` 调用生产 WorkerDispatch；收到新鲜的 Worker PID 回执后，原子落盘 ready 证据，但故意不返回 outbox callback。因此该已提交 start 事件实际尚未 ACK。

父 controller 只通过自身的 ChildProcess 对象终止子 controller，然后用只读进程清单确认旧 UID420 Worker 仍存活。新 Runtime 和 Delivery 连接重放这个真实未 ACK 事件：ownership 必须为 unknown，prepare/start 调用次数必须为零，原 handle、operation 和 reservation 字节不变，旧 Worker 仍存活。不会根据持久 PID 发送 root 信号。

父 controller 结束后，由现有 Supervisor 关闭 admission 并停止两个专用 UID、核对 user 域不存在。finalizer 保存独立停止证明，但原 Runtime 记录仍为 running/unknown，预留继续保留，不伪造 exit、不解锁、不把 Run 改成成功。父子之间的私有心跳管道在 EOF 或超时后使子 controller 自行退出，防止父进程意外消失后残留持锁 root 子进程。

第二次 scope 只用固定 wrapper + Seatbelt `/usr/bin/true` 请求重放旧 scope/generation，必须得到明确的 `Stale or missing launch scope/generation` 拒绝。任何超时、其它错误或成功执行都失败；没有业务恢复或新 Worker 派发。最后再次保留双 UID 停止证明和原 reservation。

两次 scope 共享一次冻结的独立 10 分钟预算，每次 Supervisor 上限 120 秒。原模型 Run 的三份 root 文件摘要在各阶段核对。staging 沿用已审查的安装清单协议：root 私有控制目录、Worker 私有运行目录、真实 Git fixture、固定可执行文件摘要；没有新增 OS 账户。

普通权限回归已验证真实 SIGKILL、旧 child 仍存活、未 ACK 事件重投次数增加、0 prepare/start、reservation 不变，以及私有管道 EOF 退出。普通 fixture 有固定自退出期限，因此测试不需要向恢复的 PID 发信号。这些本地回归不是 UID420 的实际部署证据。

2026-10-09 的 `-b` 已完成两轮真实部署执行，归档在 [owner-loss-actual-b](../../.bench/m0-fixes/owner-loss-actual-b)。独立只读[审计](../../.bench/m0-fixes/owner-loss-actual-b/independent-audit.json)通过 105 项核对：原报告字节、安装资产、源码摘要、真实 Git baseline、Task/Run/Attempt、输入和预留摘要、停止证明、预算及原模型任务的三份受保护文件摘要均一致。审计没有重新调用管理员或设备。

| 实际范围 | 观察结果 |
| --- | --- |
| generation 18，scope `20ba7ff2-b372-4890-aac9-4345d608b2f5` | 子 controller 实际被 `SIGKILL`；UID420 PID6059 在冷重放前后均存活。原未 ACK 的事件从 attempt1 投递到 attempt2，结果 blocked，prepare/start 均为 0。 |
| 第一轮停止 | Supervisor 在读取到 PID6059 后通过降权 reaper 终止它；UID420/421 均连续核对为空，两个 user 域均不存在。finalizer 及 controller exit0。 |
| generation 19，scope `14d6bd95-75c7-4933-85cb-260e77e92213` | 使用旧 scope/generation 的固定 `/usr/bin/true` 请求 exit1，明确原因是 `Stale or missing launch scope/generation`；没有新 Worker。第二轮双停止核对通过。 |
| 冻结预算与状态 | Run `run-0f4f8ce6-ceab-4708-bb6a-9f413d457dd3` 的 deadline 始终为 `2026-10-09T12:16:48.176Z`，repairIndex0/maxRepairs3。Runtime 始终保留 running/unknown、`safeToRedispatch=false`；原 reservation 的内容及字节摘要不变。 |

因此，A06 对应的实际 owner 丢失、未 ACK 重放拒派及旧 generation 拒绝场景已有部署证据。`modelCalls=0`、`usesActualOpenCodeExecutable=false`、`gate=not_evaluated`；本实现仍不支持自动解锁 unknown 执行，不伪造 native exit、不释放该 reservation，也不表示完整 M0 已通过。`-a` 没有安装或执行，其材料没有替代 `-b` 的实际报告。
