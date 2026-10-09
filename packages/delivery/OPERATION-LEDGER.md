# 本地 Operation Ledger 接入边界

本切片复用同一 OpenCode SQLite 数据库、迁移与事务能力，没有新增调度器。`loopit_operation` 保存逻辑动作和审计历史，`loopit_operation_authority` 保存最近核对过的资源范围与 owner/generation/epoch。它们都是本地状态，不构成独立故障域。

入口：`OperationLedger.layerFromPath(databasePath, { journal })`。与已有 Delivery 在同一进程组合时，也可使用 `OperationLedger.layerWith({ journal })` 并提供已有 `Database.Service`。

交付专用连接每次打开均设为 SQLite `synchronous=FULL` 并读回确认；Delivery 和 Ledger 的 `layerWith` 也会在事务前设置、核对调用方提供的连接，设置失败则拒绝初始化。OpenCode 上游代码未修改。此项验证的是真实连接配置与进程崩溃行为，尚未验证设备实机掉电、磁盘控制器刷写或掉电 RPO=0。

| 接口 | 当前语义 |
| --- | --- |
| `activate(scopeId, fence)` | 从外部权威端口取得当前 owner/generation/epoch 和证据引用，校验后启用当前进程的该 scope；新进程不会仅凭 SQLite 中的 ready 字段启用派发。 |
| `recordIntent(input)` | 校验 OperationRecord、请求不可变引用和摘要后写入意图；同 operationId 的请求摘要、幂等键、scope、副作用分类或请求引用变化均拒绝。同一 scope + idempotencyKey 永久绑定一个 operationId，不允许换号或换请求摘要重新派发；不同 scope 可以使用同一幂等键，但 operationId 仍须全局唯一。 |
| `prepareDispatch(operationId, fence)` | 事务内抢占一次派发，再同步请求独立恢复日志；收到绑定全部字段的有效持久回执并再次检查本地 fence 后，才返回 DispatchPermit。 |
| `recordReceipt(operationId, fence, outcome)` | 仅已获许可的动作可以记录结果；回执须带 provider evidence 的引用和摘要。相同回执重试返回已有结果，冲突回执拒绝。 |
| `markIndeterminate(operationId, fence)` | 已派发动作的结果不明时记录 indeterminate；不重新派发。 |
| `reconcile(operationId, fence, outcome)` | 由可信核对器提交核对事实后收敛未知结果；核对证据必须来自连接器真实查询，本包只校验合同和状态，不自造外部事实。 |
| `enterRecovery(scopeId)` | 持久设置 recovery-only，并将该范围未完成的已派发动作转为 indeterminate。 |
| `get(operationId)` | 读取意图、派发阶段、journal 回执、结果和审计历史。 |

## 独立端口的必要保证

`RecoveryJournal` 必须由可信集成代码注入，不能由模型提供。未接入时，activate 与派发都拒绝。

- `currentAuthority(scopeId)` 从独立于待恢复 SQLite 的授权边界返回实时 fence 和持久证据引用。不能从这份 SQLite 复制 epoch 并当成外部权威。旧备份恢复的 epoch 签发与旧权限撤销属于该边界。
- `reserveDispatch(intent)` 必须在外部原子校验当前 fence，以 `(scopeId, idempotencyKey)` 为不可换号的逻辑身份，绑定 operationId、requestDigest 和完整 intent；同时维护 operationId 的全局唯一性。即使调用方恢复到尚未记录该动作的旧 SQLite 快照，换 operationId、requestDigest、dispatchId 或 owner/epoch，也必须拒绝该逻辑身份的第二次派发；只有完全相同的 intent 重送可以返回原有回执。不同 scope 的同名幂等键相互独立。
- 只有在独立故障域完成持久化后才能返回 JournalAck；`durable.digest` 必须对应完整 DispatchIntent 的 `digestOf`，其中包括请求引用、请求摘要、幂等键、scope、dispatchId 和 fence。
- request、authority proof、journal ack 和 provider receipt 中的 DurableRef 如带 `#sha256:…`，pin 必须等于同一对象的 `digest`；相互矛盾的引用不能作为许可或核对证据。
- 端口失败、回执丢失或摘要不匹配时，不返回 permit。崩溃可能留下 `phase=awaiting_journal`；它同样阻断再次派发，恢复后必须核对。
- 可信执行代理仍须在真正执行副作用时校验 fence，携带 operationId/幂等键，并撤销旧 owner 的直连权限。这里返回 permit 不等于真实设备、渠道已经接受或执行命令。

端口声明和 URI 本身不能证明独立性；需要真实部署、凭据边界、持久化和恢复实验。本包没有提供生产 journal 实现、独立授权服务、日志重放程序或设备/发布执行代理，因此不满足 M0-A11 的整体验收。

## 有意保留的限制

当前每个逻辑 operation 最多授予一次 permit；包括 failed 在内的结果不会自动重发。未来如需重试，必须由真实连接器证明未执行或提供可靠幂等保证，并加入相应 journal 协议；不能通过新建 operationId 绕过未知结果。

迁移 `loopit_0003_operation_logical_identity` 在原有 0002 表上增加 `(scope_id, entry.record.idempotencyKey)` 的 SQLite 唯一索引，事务内也检查同一约束。若旧数据库已经存在冲突的逻辑身份，迁移失败并保留全部原始记录；不会自动合并、删除或认定未知动作未执行。此时 Ledger 拒绝启动，必须先通过独立核对处理历史冲突；本包没有提供绕过约束的迁移开关。

Delivery 和 Ledger 共用迁移入口：SQLite immediate 事务覆盖已应用版本读取、DDL 和版本写入，防止多个进程同时升级时重复执行同一迁移。0003 可接受已存在且定义完全匹配的索引；同名但不唯一、字段或表达式不同的索引会阻断升级。

本地 `dispatched` 是派发流程已开始，须结合 `phase` 判断：`awaiting_journal` 尚未授予许可，`permitted` 才已产生许可。无论哪一阶段，进程退出、超时和没有收到回执都不能推出业务成功或未执行。

测试使用真实 SQLite、四进程竞争、进程强杀和有效数据库快照；`FakeJournal` 仅测试协议行为，既不持久也不独立，不得接入实际副作用。测试没有操作设备、网络渠道或真实发布资源。
