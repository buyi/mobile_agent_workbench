# M0 选型记录：OpenCode 沿用 / 扩展 / 缺失、BOM 与能力矩阵

日期：2026-10-08。对应 [M0-T01](../milestones/m0-contracts-and-integration.md#6-实施切片与依赖) 与 M0-F13 的阶段性输出。本文记录**已实测**与**未验证**的边界；M0 整体尚未 passed，不能据此宣称任何未列为 supported 的能力。

## 1 锁定版本（Bill of Materials，部分）

| 组件 | 版本 / 来源 | 许可 | 用途 | 状态 |
| --- | --- | --- | --- | --- |
| OpenCode | tag `v1.18.35`，commit `53d1eabb61e21162157817bf677da0a4ad3332e3`，git submodule `vendor/opencode` | MIT（根 LICENSE） | 唯一底座：数据库、`EventV2`、迁移、Agent Runtime | 锁定 |
| `@opencode-ai/core`、`@opencode-ai/schema`、`effect-drizzle-sqlite` | 随 OpenCode 工作区 | MIT（package.json） | 交付层直接依赖 | 锁定 |
| effect | 4.0.0-beta.83（OpenCode `bun.lock`） | MIT | schema 与运行时 | 锁定，beta 版本，升级需重跑合同 |
| drizzle-orm | 1.0.0-rc.2（OpenCode `bun.lock`） | Apache-2.0 | 表定义与查询 | 锁定，RC 版本 |
| Bun | 1.3.14（OpenCode `packageManager`） | MIT | 运行与测试 | 本机安装于 `~/.bun` |
| typescript | 5.8.2 | Apache-2.0 | 类型检查 | 锁定 |

传递依赖（OpenCode 安装 4693 个包）的逐项许可、NOTICE 与供应链审计**未完成**，列为 unverified，M0-T08 前补齐。必需执行路径不含 Claude Agent SDK / Claude Code 核心。

安装方式（干净 Worker 可复现）：

```text
git submodule update --init --depth 1 vendor/opencode
(cd vendor/opencode && bun install --frozen-lockfile)
bun script/setup.ts          # 将 node_modules 链接到 OpenCode 锁定的同一份依赖实例
bun script/bench.ts verify --suite contract-core --dataset contract-core/1
bun script/bench.ts verify --suite control-plane
```

升级方式：只能在新分支移动 submodule 到新 tag，重跑全部 `bench` 套件并更新本文与 ADR-0002；不跟随最新版本自动升级。

## 2 沿用 / 扩展 / 缺失

| 规格职责 | OpenCode 现有能力（v1.18.35，已读源码） | 处理 | 本仓库实现 |
| --- | --- | --- | --- |
| 持久事件、聚合序号、投影 | `EventV2`：`BEGIN IMMEDIATE` 事务内写 `event`/`event_sequence`，运行 projector，`commit(seq)` 钩子，提交后通知 | **沿用** | 交付事件用自定义 durable 定义发布 |
| 命令回执 + outbox 同事务 | 无交付语义 | **扩展**（`commit` 钩子） | `loopit_command_receipt`、`loopit_outbox` |
| 数据库与迁移 | SQLite（WAL，`synchronous=NORMAL`）、`DatabaseMigration.applyOnly` | **沿用** | `loopit_0001_delivery_core` |
| 按游标读取、订阅 | `readAggregate`（接受调用方清单）；`durable()` 流只认静态清单 | 沿用 `readAggregate`；订阅**扩展** | `readEvents`、`watch`（先订阅再补读，按版本去重，有界队列溢出即断开） |
| 跨设备 sync / replay | 只覆盖静态清单中的会话事件 | **缺失** | M2 前决定：向上游提清单扩展点或 fork（ADR-0002） |
| 插件扩展 | v1 hooks、v2 effect：工具、agent、catalog 等；**不暴露数据库与 durable 事件** | 工具类扩展沿用；交付层不能仅靠插件 | 交付层以进程内库依赖 `@opencode-ai/core` |
| 工作区 / Worker | `control-plane` 的 WorkspaceAdapter（local/remote target） | 待 T03 实测 | — |
| Agent 循环、会话、工具、压缩、子代理 | 原生 | **沿用**（不自研第二套编码循环） | — |
| OS 沙盒 | 权限交互不构成隔离（官方 SECURITY.md） | **缺失** | T03 |
| 设备 Broker、构建/安装身份、渠道 | 无 | **缺失** | T04/T05 |
| 独立 Gate 签发、Operation Ledger、独立恢复日志 | 无 | **缺失** | 合同已定义（`gate/1`、`operation/1`），执行在 T05/T06 |
| 服务接口 | `server/` HTTP API、SDK | 待接入 | 交付命令的 HTTP 暴露在 M1-I01 |

## 3 能力矩阵（本轮实测范围）

状态取值：supported（已在锁定版本实测）、limited、unsupported、unverified。只有 supported 可用于无人交付承诺。

| 能力 | 状态 | 证据 / 限制 |
| --- | --- | --- |
| 合同解析、schemaVersion 拒绝、交叉校验（M0-F01） | supported | `bench verify --suite contract-core`：79/79，数据集 `contract-core/1` |
| 命令去重、版本冲突、单事件原子提交（M0-F02） | supported | `control-plane`：同进程 10 次重发、4 进程同 commandId、4 进程同版本修订（实测触发事务内版本竞争并正确判冲突） |
| 事务中断不留部分事实（M0-A03） | supported（进程崩溃） | 事务内、提交后派发前、派发中三个点 `kill -9` 后核对；**整机掉电未测**，见下行 |
| 已回执事务掉电 RPO=0（P10） | limited | OpenCode 使用 WAL + `synchronous=NORMAL`，掉电可能丢失最后提交；需在交付连接上改为 `FULL` 并实测 |
| 投影与事件重放一致（S17） | supported | `replay` 与投影逐字段相等 |
| 订阅：游标补读 + 实时 + 背压（P03/P05 机制） | limited | 机制已测；延迟与 10,000 事件重连的性能未测 |
| outbox 至少一次投递 | supported | 派发中崩溃后以 attempt=2 重投同一 eventId；消费者须按 eventId 去重 |
| Run 状态机：暂停/取消须执行器确认，终态不恢复（M0-F04 的状态部分） | supported（状态层） | 进程树停止、设备核对属 T03/T04，unverified |
| 预算不随新 Run 重置；已结案失败不改写（M0-A14） | supported（状态层） | 以 Run 次数 = 1 + maxRepairCycles 计；金额/时间封顶需执行层计量 |
| Runtime 生命周期、沙盒、停止与恢复（M0-F03/F05/F07） | unverified | T03 未开始：需要模型凭据与沙盒方案 |
| 设备、构建身份、渠道（M0-F08–F10） | unverified | T04/T05 被用户输入阻塞 |
| 独立 Gate、上下文重建、计量（M0-F11/F12） | unverified | 合同与证据绑定规则已有单元测试；签发身份与存储未实现 |

## 4 M0 验收条目当前状态

| ID | 状态 | 说明 |
| --- | --- | --- |
| M0-A01 | 符合预期（合同层） | contract-core 套件 |
| M0-A02 | 符合预期 | control-plane 套件，含跨进程 |
| M0-A03 | 部分 | 进程崩溃三个点已测；派发去重依赖消费者按 eventId 去重；掉电未测 |
| M0-A14 | 符合预期（状态层） | control-plane 套件 |
| M0-A04–A13、A15 | notRun | 依赖 T03–T07 或用户输入 |

M0 MilestoneManifest 只能在 T08 由独立检查器签发；当前若签发只能是 `blocked`。

## 5 待用户冻结（Decision Register）

| 决策 | 阻塞 |
| --- | --- |
| 首个真实功能及验收条目 | M0-A15、M1 |
| 首验平台、真机标识与 OS、fixture | T04、M0-A08/A09 |
| 内部分发渠道、签名/分发凭据引用、停止分发方式 | T05、M0-A10/A11 |
| 预算、观察窗口 | M1 GoalSpec 冻结 |
| macOS Worker 主机 | T03 的 iOS 路线、T04 |
| 模型提供方与凭据引用 | T03、M0-A04 |
| 产品模型 Project → Task → Run → Delivery | 公开 API 冻结（不阻塞 M0 合同） |
