# ADR-0002：交付状态存放在 OpenCode 原生存储与事件机制上

日期：2026-10-08。状态：**已接受（M0-T01 实验依据）**。上游：[ADR-0001](0001-opencode-base.md)、[执行契约 §7.1](../execution-contracts.md#71-事件与命令)、[M0-F02](../milestones/m0-contracts-and-integration.md#m0-f02-权威任务状态)。

## 背景

M0-F02 要求命令回执、领域事件、投影与 outbox 在同一事务落库，并优先使用所选底座的持久化机制。候选方案：

| 方案 | 说明 |
| --- | --- |
| A | Loopit 交付事件与表进入 OpenCode 的 SQLite，复用 `@opencode-ai/core` 的 `Database` 与 `EventV2` |
| B | 独立 SQLite 文件，Loopit 自行实现事件/投影 |
| C | fork OpenCode，把交付对象加入其静态事件清单与 schema 生成流程 |

## 已核对的事实（锁定版本 v1.18.35，commit `53d1eabb61e2`）

- `EventV2.publish(definition, data, { commit })` 对 durable 事件在 `BEGIN IMMEDIATE` 事务中依次执行：按聚合读取 `seq`、运行已注册 projector、调用 `commit(seq)`、写 `event_sequence` 与 `event`。任一步失败整体回滚；提交后才唤醒订阅者。上游测试 `packages/core/test/event.test.ts` 在本机 44/44 通过。
- `publish` 使用传入的 definition，不要求事件类型出现在 OpenCode 静态 `Durable` 清单中。
- `EventV2.durable()` 流与 `replay` 只认静态清单；`EventV2.readAggregate(db, { manifest })` 接受调用方清单，可按聚合游标读取自定义事件。
- `DatabaseMigration.applyOnly(db, migrations)` 可在同库应用调用方迁移，记录在同一 `migration` 表。
- 插件 API（v1 hooks、v2 effect）不暴露数据库或 durable 事件，交付层不能仅以插件形式获得事务能力。

本机实验（已删除的临时探针，结论复现于 `packages/delivery/test`）：自定义 `loopit.task.created` 事件 + 回执表在同一事务提交；`commit` 抛错时事件与回执均未落库；`readAggregate` 用自定义清单读回 1 条。

## 决定

采用 **方案 A**：

1. `packages/delivery` 以进程内库形式依赖 `@opencode-ai/core`，与 OpenCode 服务共用同一个数据库文件与 `EventV2` 实例。
2. 每个 Task 是一个事件聚合（`aggregate = taskId`），聚合 `seq + 1` 即 `aggregateVersion`，客户端 `expectedVersion` 与之比较。
3. 一条被接受的命令产生且仅产生一个 durable 事件；投影通过 `EventV2.project` 注册（可从事件重建）；命令回执与 outbox 写在 `commit` 钩子内（本地运行事实，不参与 replay）。
4. `expectedVersion` 校验与回执唯一性在 `commit` 钩子内、事务之中完成，因此跨进程并发同样成立，不依赖进程内锁。
5. 被拒绝的命令（版本冲突、非法转换）只写回执、不写事件；schema 非法的输入在任何写入前拒绝，不生成回执。

方案 B 会形成第二个权威库，违背“保持一个权威业务状态”；方案 C 当前没有必要，保留为 M1 需要将交付事件纳入 OpenCode 同步/replay 时的选项。

## 已知缺口与后续

| 项 | 影响 | 处理 |
| --- | --- | --- |
| 自定义事件不在 OpenCode 静态清单，`durable()` 流与跨设备 sync 不覆盖 | 交付事件不能经 OpenCode 原生 sync 复制到其他设备 | M0 用 `readAggregate` + 提交后通知实现订阅；M2 三端前评估向上游提交清单扩展点或方案 C |
| 交付层需进程内运行 | 需要在 OpenCode server 进程中注册路由/服务 | M0-T02 以库及测试证明合同；HTTP 暴露在 M1-I01 处理 |
| OpenCode `synchronous = NORMAL` + WAL | 断电时可能丢失最后已提交事务，不满足 P10 “已回执事务 RPO=0” 对整机掉电的要求 | 进程崩溃不受影响（已测）；整机掉电需改为 `FULL` 或在交付库连接上覆盖，列入能力矩阵 `limited` |
| 独立故障域恢复日志（M0-F06/A11） | 同库无法满足 | 与本决定无关，T05 单独选择存储 |

## 重新评估条件

若 OpenCode 升级改变 `EventV2` 事务语义、`commit` 钩子或迁移接口，重跑 `bench verify --suite control-plane`；不通过则回到本 ADR 记录新的方案。
