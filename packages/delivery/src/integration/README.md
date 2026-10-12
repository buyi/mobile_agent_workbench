# Delivery → 本地 Runtime 接线

`WorkerDispatch.layerFromPath(databasePath, { adapter, launch })` 复用 Delivery 的 OpenCode SQLite 连接、持久 outbox 和迁移事务。组合已有服务时可用 `layerWith` 注入同一 `Database.Service` 与 `Delivery.Service`。没有单独的派发数据库。

`consume`、`drain` 和 `inspect` 拒绝 Effect ambient 外层事务；调用方不能在未提交的 create/start 事务中触发外部执行。否则嵌套 reservation 只是 savepoint，外层回滚后可能出现“进程已启动但目标和派发记录消失”。`get` 仅作读取，可在事务内使用。

`launch` 是可信宿主配置函数，提供已锁定 Runtime、模型、工作目录和本次 wall budget。模块把已提交 Run 的冻结 GoalSpec 构造成 `ExecutionSpec`、`ContextManifest` 和提示内容，固定模型、权限、指令摘要和 policy pin。默认 deny-all；启用受限编辑时，可信宿主传入 Runtime 的 `restrictedConfigBinding(config)` 与 `executionBudget:{deadlineAt,repairIndex,maxRepairs:3}`，完整公开配置和预算摘要一同绑定 ContextManifest，OAuth resolver/结果不进入 Launch 或持久输入。当前只支持本地 Adapter 已实现的输入子集，不展开外部知识、历史、技能或工具。

| 接口 | 行为 |
| --- | --- |
| `drain(limit?)` | 通过现有 Delivery outbox 消费已提交事件；处理记录完成后才确认投递。 |
| `consume(item)` | 先核对 item 确实来自同一个数据库的 outbox。startRun 创建确定性的 Run/Attempt/operation 绑定，提交 reservation 后才调用 Adapter。相同事件重复投递只读取已有 handle；不会再次调用 start。 |
| `inspect(runId)` | 保存真实 Adapter 观察。观察到本地 started 才报告 running；进程退出最多报告 waiting 或真实 spawn failure，不创建通过的 Gate。 |
| `get(runId)` | 读取不可换号的派发绑定、完整输入、阶段及最近观察。reserved 只代表预留，不能推出进程已经启动。 |

暂停、取消和目标修订引起的停止调用已有 Adapter emergency stop。SQLite 写入失败不能阻止已经取得 handle 的本地紧急停止。Adapter 当前无法排除逃逸后代和外部动作，始终 `safeToRedispatch=false`，因此控制面保持 pausing/cancelling，等待独立 Supervisor 核对；本模块不改写为安全、不释放 Runtime reservation。resume 不自动创建新 Attempt。

崩溃后即使 reservation 没有对应 Runtime receipt，也保持阻断。Adapter 对恢复出的 handle 报 unknown ownership 时，不猜 PID、不信号、不重复 spawn。派发失败不自动重试；无效 launch 保存为 quarantined，事件处理结束，后续控制消息仍可继续处理。

reservation 提交后，`prepareStart` 在写事务外用异步子进程进行 version/help 探测，每个最多 5 秒、输出最多 64 KiB。它返回只在同一 Adapter 实例有效的单次 token，绑定完整输入与 operationId。最终 queued 检查与同步 `startPrepared` 在第二个 SQLite immediate 事务内执行，使已接受的 pause/cancel 不被新派发越过；不可伪造 token 绕过探测，也不能替换输入或二进制摘要。最终事务仍包含二进制/输入哈希与本地文件 I/O，尚未验证生产负载、慢磁盘或大型输入下的控制延迟。

这里没有 Agent 推理循环、持久 Supervisor、候选分支准备器、设备/发布接线、完整费用账本或跨故障域恢复协议。受限模式由 Runtime 的独立可信 resolver 在内存提供 access-only 凭据；Delivery 不接触秘密。SQLite reservation 同时持久绑定首个 GoalRevision deadline（不超过冻结目标预算/60分钟）和已提交 Run 计数对应的 repairIndex（至多3）；重开连接不能重置 deadline。默认 deny-all 模式仍只有本次 wall budget。恢复旧数据库快照、清空 Runtime 状态等场景仍需独立 RecoveryJournal 和 fencing；本模块的本地 reservation 不满足 M0-A11。

测试使用可控真实子进程、实际 SQLite、多进程重复投递和两个 SIGKILL 窗口。fixture 可以正常退出或被停止，只证明本地接线；不代表真实 OpenCode 自主交付、独立停止核对或 M0 整体验收通过。

新增受限配置/预算测试只证明配置绑定、真实 SQLite 持久准入和拒绝条件；UID420、Seatbelt、真实付费编辑需宿主的独立集成证据，不能从无权限的 fixture 测试推导通过。
