# M0 选型记录：OpenCode 沿用 / 扩展 / 缺失、BOM 与能力矩阵

更新日期：2026-10-09。对应 [M0-T01](../milestones/m0-contracts-and-integration.md#6-实施切片与依赖) 与 M0-F13 的阶段性输出。本文记录**已实测**与**未验证**的边界；M0 整体尚未 passed，不能据此宣称任何未列为 supported 的能力。

本机有限代码任务现已完成真实 `Delivery → OpenCode → 独立 Verifier → Gate → Delivery` 链路，成功 Run 为 `run-46a51a51-d1ce-45f2-83f6-719cc4fc2bb8`。专用 Worker、Supervisor、UID 421 signer 和持久上下文重建均已接通；这一范围内的成功不等于 M0 整阶段通过或 M1 诊断页已实现。

## 1 锁定版本（Bill of Materials，部分）

| 组件 | 版本 / 来源 | 许可 | 用途 | 状态 |
| --- | --- | --- | --- | --- |
| OpenCode | tag `v1.18.35`，commit `53d1eabb61e21162157817bf677da0a4ad3332e3`，git submodule `vendor/opencode` | MIT（根 LICENSE） | 唯一底座：数据库、`EventV2`、迁移、Agent Runtime | 锁定 |
| `@opencode-ai/core`、`@opencode-ai/schema`、`effect-drizzle-sqlite` | 随 OpenCode 工作区 | MIT（package.json） | 交付层直接依赖 | 锁定 |
| effect | 4.0.0-beta.83（OpenCode `bun.lock`） | MIT | schema 与运行时 | 锁定，beta 版本，升级需重跑合同 |
| drizzle-orm | 1.0.0-rc.2（OpenCode `bun.lock`） | Apache-2.0 | 表定义与查询 | 锁定，RC 版本 |
| Bun（工作台开发与测试） | 1.4.2，官方固定发行资产，摘要见 [工具链记录](workbench-toolchain.json) | MIT | 编排库、合同及回归测试的宿主 | 本仓库固定版本；同组 36 文件单进程与额外管道/SQLite 样本已验证；本机独立副本，不覆盖全局安装 |
| Bun（历史受保护 M0 部署） | 1.3.14；上游 OpenCode `packageManager` 原样保留 | MIT | 已归档的模型、Supervisor/Verifier 与控制实验 | 旧部署与证据保持原始版本；新工具链的受保护安装、控制矩阵与签发复验仍待完成 |
| typescript | 5.8.2 | Apache-2.0 | 类型检查 | 锁定 |
| mobile-ui-runtime / `dsh-mobile-ui` | 0.1.0，commit `04975ff4e63f3448e19e8c5ec1c6394dd12a1ad1`，`vendor/mobile-ui-runtime` submodule | MIT（根 LICENSE） | 通用设备会话、语义树、revision/action/diff、共享队列、App Ops 与 Evidence；复用 core/provider，不加载 DSH 插件 | 用户已确认复用；锁定已提交版本，保留原工程未提交改动；可信设备宿主接线和实测仍未完成 |
| agent-device | 0.21.1，本机既有安装 | MIT | iOS XCTest 设备工具；不运行 Agent 推理循环 | 新增 3 个 Swift 文件的私有补丁，版本及原文件摘要见 `script/m0/ios-runner-state.lock.json`；共享安装不变 |

传递依赖的逐项许可、NOTICE 与供应链审计**未完成**，列为 unverified，M0-T08 前补齐。必需执行路径不含 Claude Agent SDK / Claude Code 核心。

本轮离线生成依赖元数据清单 `.bench/m0-fixes/dependency-inventory.json`：观察到 761 个已安装包实例，其中 core 可解析依赖闭包为 613 个。core 闭包有 45 个许可证证据缺口（1 个缺声明，44 个未找到包内许可文件）。未安装可选依赖、其他平台包及无法精确匹配的锁文件条目单列；这些记录不代表法律兼容性或原生二进制审计通过。

本轮可复现的依赖安装入口（沿用上游锁文件，仅选择 core 工作区；不代表专用 Worker 已配置或全部客户端构建已验证）：

```text
bun --version  # 本仓库开发/测试固定为 1.4.2
git submodule update --init --depth 1 vendor/opencode
git submodule update --init vendor/mobile-ui-runtime
(cd vendor/opencode && bun install --frozen-lockfile --filter '@opencode-ai/core' --registry https://registry.npmjs.org --network-concurrency 4)
bun script/setup.ts          # 链接同一份依赖实例，以及 tsc / tsserver 可执行入口
bun run typecheck
bun test ./script/test
bun script/bench.ts verify --suite contract-core --dataset contract-core/1
bun script/bench.ts verify --suite control-plane
```

升级方式：只能在新分支移动 submodule 到新 tag，重跑全部 `bench` 套件并更新本文与 ADR-0002；不跟随最新版本自动升级。

## 2 沿用 / 扩展 / 缺失

| 规格职责 | OpenCode 现有能力（v1.18.35，已读源码） | 处理 | 本仓库实现 |
| --- | --- | --- | --- |
| 持久事件、聚合序号、投影 | `EventV2`：`BEGIN IMMEDIATE` 事务内写 `event`/`event_sequence`，运行 projector，`commit(seq)` 钩子，提交后通知 | **沿用** | 交付事件用自定义 durable 定义发布 |
| 命令回执 + outbox 同事务 | 无交付语义 | **扩展**（`commit` 钩子） | `loopit_command_receipt`、`loopit_outbox` |
| 数据库与迁移 | SQLite（WAL，`synchronous=NORMAL`）、`DatabaseMigration.applyOnly` | **沿用 + 启动适配** | 自有迁移及派发表保留在同一 OpenCode 数据库；交付连接显式设 FULL 并核对。打开数据库时仅对 SQLite BUSY 有界等待；迁移版本检查、DDL 与 marker 同属 immediate 事务，不重试交付命令 |
| 按游标读取、订阅 | `readAggregate`（接受调用方清单）；`durable()` 流只认静态清单 | 沿用 `readAggregate`；订阅**扩展** | `readEvents`、`watch`（先订阅再补读，按版本去重，有界队列溢出即断开） |
| 跨设备 sync / replay | 只覆盖静态清单中的会话事件 | **缺失** | M2 前决定：向上游提清单扩展点或 fork（ADR-0002） |
| 插件扩展 | v1 hooks、v2 effect：工具、agent、catalog 等；**不暴露数据库与 durable 事件** | 工具类扩展沿用；交付层不能仅靠插件 | 交付层以进程内库依赖 `@opencode-ai/core` |
| 工作区 / Worker | `control-plane` 的 WorkspaceAdapter（local/remote target） | **有界本地接线** | 本仓库固定工作区 + WorkerDispatch + 专用 UID 420；不声称上游 local/remote WorkspaceAdapter 全部已验收 |
| Agent 循环、会话、工具、压缩、子代理 | 原生 | **沿用**（不自研第二套编码循环） | — |
| OS 沙盒 | 权限交互不构成隔离（官方 SECURITY.md） | **扩展** | `packages/sandbox`：Seatbelt + 专用账户 |
| 设备 Broker、构建/安装身份、渠道 | 无 | **扩展 / 尚有缺口** | 本机 Broker 租约/fence、安装回执丢失查询、清理失败隔离已真实实验；OS 独占、撤权及正式 Run/Gate 接线未完成 |
| 独立 Gate 签发、Operation Ledger、独立恢复日志 | 无 | **扩展 / 尚有缺口** | 操作账本、本机独立进程 journal、UID 421 有限签发、控制面验签与 CLI 限定范围部署注册已接通；独立恢复故障域与整阶段完整证据未完成 |
| 服务接口 | `server/` HTTP API、SDK | 待接入 | 交付命令的 HTTP 暴露在 M1-I01 |

## 3 能力矩阵（本轮实测范围）

状态取值：supported（已在锁定版本实测）、limited、unsupported、unverified。只有 supported 可用于无人交付承诺。

下表套件计数指所列实验的已归档快照，不代表当前仓库测试总数。真实主链路与设备实验的范围另列，不能用旧套件数字覆盖后续实际结果。

| 能力 | 状态 | 证据 / 限制 |
| --- | --- | --- |
| 合同解析、schemaVersion 拒绝、交叉校验（M0-F01） | supported | `bench verify --suite contract-core`：104/104（含绑定与阶段检查器回归），固定样本 `contract-core/1`；回归还覆盖验收内容摘要、重复结论、设备身份/OS 和 rubric 版本 |
| 命令去重、版本冲突、单事件原子提交（M0-F02） | supported | `control-plane`：63/63（含 12 项 WorkerDispatch 接线）；同进程 10 次重发、4 进程同 commandId/同版本修订/同 Run ID 竞争；全局 Run ID 冲突拒绝且不留下事件或 outbox |
| 数据库并发启动的 BUSY 处理 | supported（启动层） | 3 个真实锁测试：释放后成功、持续锁到期失败、非 BUSY 立即失败；只重试打开数据库，默认上限 5 秒，不重试 `execute()`；同命令 4 进程测试连续 25 轮通过 |
| 事务中断不留部分事实（M0-A03） | supported（进程崩溃） | 事务内、提交后派发前、派发中三个点 `kill -9` 后核对；**整机掉电未测**，见下行 |
| 已回执事务掉电 RPO=0（P10） | limited | 本包所有交付连接及注入入口已设 `synchronous=FULL` 并读回验证；真实连接、新 scope、注入 NORMAL 与事务内拒绝均已测。上游代码未改；整机掉电与底层存储耐久仍未实测 |
| 投影与事件重放一致（S17） | supported | `replay` 与投影逐字段相等 |
| 订阅：游标补读 + 实时 + 背压（P03/P05 机制） | limited | 机制已测；延迟与 10,000 事件重连的性能未测 |
| outbox 至少一次投递 | supported | 派发中崩溃后以 attempt=2 重投同一 eventId；消费者须按 eventId 去重 |
| Run 状态机：暂停/取消须执行器确认，终态不恢复（M0-F04 的状态部分） | supported（状态层） | `reportRun` 不能绕过控制命令解除暂停，需先有权限的 `resumeRun`；本机专用 UID 停止核对已接通，未知设备/远端动作不能据此视为停止 |
| 预算不随新 Run 重置；已结案失败不改写（M0-A14） | supported（状态层与本次冻结预算） | 实际成功 Run 的 repairIndex=2、maxRepairs=3，原 60 分钟 deadline 未重置，前两个失败 Run 保留原终态；USD 费用与第二 Run 模型用量仍 unknown，不声称美元封顶或全程计量已知 |
| Runtime 本地 CLI 接线 | limited | `runtime-local`：17/17，包含 16 项可控进程实验与 1 项真实 OpenCode 1.18.35 版本/帮助探测；隔离环境、重复派发、进程组停止和未知状态阻断已测。父退出后仍保留并发占用；磁盘错误不阻止本地紧急停止，证据明确不可用。详见 [包边界](../../packages/runtime/README.md) |
| Delivery → Runtime 本地派发 | limited | 同一 OpenCode 数据库保存派发 reservation，消费真实已提交 outbox；重复事件与 3 进程竞争只启动一次，两个 SIGKILL 窗口后拒绝盲目重派，已暂停任务不启动；慢探测期间同进程/跨进程暂停可提交并阻止启动，外层未提交事务不允许派发。未知停止不改写为 paused/cancelled，详见 [接线边界](../../packages/delivery/src/integration/README.md) |
| Runtime 实际编辑（M0-F03 的部分） | limited | 专用 UID 420 + Seatbelt 的实际成功 Run 已接 Delivery、WorkerDispatch、独立 UID 421 签发与 Gate；12 个固定用例通过，5 个 model steps / 14,583 reported tokens。CLI 仍未暴露执行前持久 ACK，未知派发须独立停止核对 |
| Runtime 完整停止与恢复（M0-F05） | limited（本机专用 UID） | 真实探针覆盖 leader、setsid 后代、旧 scope/generation 与停止阶段拒绝；Supervisor 核对专用 UID 进程与 user 域均为空。第二 Run 的 ambiguous 派发停止核对后以 failed 结案，后续 Run 沿用原预算；不把停止证明解释为已知模型用量或外部副作用结果，不覆盖远端作业 |
| macOS 沙盒：写入/读取/网络限制（M0-F07） | limited | 正式结果 28 通过、0 失败、2 notRun；同一公网端点 `111.132.47.193:443` 在沙盒外可达、`none`/`proxy` 内直接连接均拒绝。直接 CoreSimulator 访问也已测为沙盒外可用、内拒绝；root harness 的两项独立跨账户文件实验另已通过；当前操作者运行的内置账户用例仍为 2 notRun，整套 `sandbox-contract` 仍 blocked（[ADR-0003](../decisions/0003-macos-worker-sandbox.md)） |
| macOS 进程隔离 | limited | 无 PID 命名空间；已部署 Supervisor，以专用 UID 实时清单、launch gate 与 user 域核对停止，实际探针含 setsid 后代；不依持久 PID 对未知进程发特权信号，不覆盖外部作业 |
| macOS 账户隔离 | limited | 专用账户已创建并审计；两项明确私有文件的跨账户读取拒绝已测。真实模型 Worker UID 420、Verifier UID 421 已部署，密钥与控制态不归 Worker 所有；与原沙盒套件的所有用例仍不能直接互换 |
| Linux 沙盒（bubblewrap） | unsupported | 仅保留接口位置 |
| 设备、构建身份、渠道（M0-F08–F10） | limited（真实本机渠道） | ReleaseTest 包构建/安装身份及替换拒绝已实测；新增真实 Broker 实验只安装 1 次、查询 1 次，回执丢失/查询不可用时拒绝重派，清理失败隔离后卸载并关机。相同 OS UID 仍可直连 simctl，且实验未绑定正式 Run/Gate；见 [设备实验](../../script/m0/IOS-BROKER-EXPERIMENT.md) |
| 独立进程恢复日志 | limited（本机协议） | `recovery-journal-local`：12/12；进程退出码与成功/拒绝回执一致，FULL 提交后 ACK、fence 推进、并发、回执前 SIGKILL、旧快照重放阻断已测。实际本机安装已使用本机 Journal 核对，仍无独立故障域/受限远端身份，不能满足 A11；见 [协议](../../packages/recovery-journal/PROTOCOL.md) |
| 独立 Gate、上下文重建、计量（M0-F11/F12） | limited（已接有限真实任务） | UID 421 已签发成功候选及 delivery Gate，控制面验签并核对字节；持久上下文重建 ready、事件回放一致，成功 Run token 已记录。CLI 已通过 root 固定索引接入特定 Goal/Run 的部署证明；15 项阶段证据未齐仍 blocked。第二 Run 用量和 USD 费用保持 unknown |
| 评测入口与安装入口 | supported（工具回归范围） | 脚本回归共 50 项：评测/安装入口 13 项、产物摘要 13 项、阶段 CLI 3 项、iOS 状态适配 21 项；包含真实子进程与回环 HTTP。沙盒禁止端口监听时最后一组不能执行；本机允许监听环境中全部通过。fresh setup 后 `bun run typecheck` 可用 |

### 已接通控制面的真实代码任务（2026-10-09）

归档根目录 `.bench/m0-fixes/control-loop-actual/code-task-passed/` 保存 `status.json`、`reports/` 与 `run-history/`。它证明固定 `sumEvenThrough.ts` 任务 `M0-CODE-01` 已跑通；没有修改 Loopit 业务功能，`milestonePassed=false`、`m1FeatureImplemented=false`。

| 项目 | 实测结果 / 边界 |
| --- | --- |
| 身份及派发 | 专用 UID 420 的原版 OpenCode，经已提交 outbox、持久 reservation、受限执行配置与 Seatbelt 启动；成功 Run `run-46a51a51-d1ce-45f2-83f6-719cc4fc2bb8` |
| 验证与签发 | UID 421 Verifier 的固定 12 用例全部通过；`reports/verification-evidence.json`、`signed-check.json` 与 `gate.json` 绑定同一目标、验收、Run 和候选，控制器验签后报告 succeeded |
| 签发器正反例 | 8 组 conformance 通过：正确/错误候选、缺候选、错候选摘要、错 Run、调用者公钥、重复请求、签名篡改；报告在 `run-history/run-3c531003-ad06-4117-821a-384194cd5158/reports/signer-conformance-0061b3d3-6878-41ef-a44d-74f1ca5876d4.json`，没有模型调用 |
| 停止与上下文 | Supervisor 核对 Worker/signer 专用 UID 无存活进程且 user 域不存在；`reports/recovered-context.json` 为 ready / 无 issues，事件回放匹配。范围仅本机专用 UID，不能替代设备或远端核对 |
| 冻结预算 | 原 60 分钟 deadline `2026-10-09T11:08:25.455Z` 未重置；成功 Run 为 repairIndex=2、maxRepairs=3，两个历史失败 Run 未改写 |
| 成功 Run 用量 | `opencode.step_finish` 去重后 5 model steps，native reported total **14,583 tokens**；USD 费用 unknown，reportedCost=0 不解释为免费 |
| 不完整用量 | 第二 Run `run-582a99fb-0203-4c02-bfe9-4c9a0803c2d5` 的派发结果曾不明，停止核对后 failed，用量仍 unknown。不能称其零调用/零费用，也不能把两个有原生记录的 Run tokens 相加当全程已知总量；供应商内部重试次数也未知 |

### 早期独立 Runtime 编辑实验（2026-10-09）

[`script/m0/runtime-edit-probe.ts`](../../script/m0/runtime-edit-probe.ts) 独立于 `runtime-local` 套件执行。它复用 OpenCode 原生 Agent 循环，只修改临时 fixture，未修改 Loopit 业务源码。

| 项目 | 实测结果 / 边界 |
| --- | --- |
| 执行身份 | OpenCode `v1.18.35`；原生持久消息核对模型为 `openai/gpt-6.1-sol`，variant `low` |
| 次数与时间 | **1 次 CLI Runtime 运行，3 个模型轮次**；17,466 ms，0 次自动修复；本次进程超时上限 60 秒 |
| 实际行为 | 仅观察到 `read`、`apply_patch` 两个工具调用；将 `sumEvenThrough` 的 `< n` 修为 `<= n` |
| 固定独立测试 | 测试文件位于模型不可写范围，摘要不变；已知错误实现有 4 项失败，已知正确实现及模型候选均为 12/12 通过 |
| OS 边界 | 模型在 Seatbelt 中仅可写临时工作区与独立运行态目录，仅可连接既有 `localhost:7897` 代理；测试另用 `network=none`，无凭据环境，未退化裸跑 |
| 认证 | 原生 `OPENCODE_AUTH_CONTENT` 仅提供有效 access、到期信息及账户标识，refresh 为空；原认证文件摘要未变，报告扫描未发现 access/refresh 原文 |
| 用量 | 原生事件合计 6160 tokens：input 4262、output 200、reasoning 34、cache read 1664；OAuth 美元费用为 `unknown`，原生 reportedCost=0 不作实际零费用结论 |
| ACK / settled / Gate | CLI 未暴露执行前持久 ACK；进程退出为 0，事后数据库可见持久用户消息；固定测试通过，但没有独立签名 Gate |
| 该次实验的范围 | 这份早期报告本身未证明 Supervisor、逃逸后代停止、真实恢复或专用 Worker 身份，后续证据见上一节；代理端口限制不等于域名白名单。上游 `apply_patch` 移动目的地未单独纳入 edit pattern，本实验检查额外工作区变更后才执行候选 |

原始结果与原生记录核验位于本机 `/private/tmp/loopit-m0-edit-LicvvL/reports/result.json`、`post-check.json`；报告副本已保留到 `.bench/m0-fixes/runtime-edit/`，副本清单为 `.bench/m0-fixes/runtime-edit-copy-manifest.json`。这是有界编辑实验的证据，不是完整 M0 或自主交付通过证明。

## 4 M0 验收条目当前状态

| ID | 状态 | 说明 |
| --- | --- | --- |
| M0-A01 | 符合预期（合同层） | contract-core 套件 |
| M0-A02 | 符合预期 | control-plane 套件，含跨进程 |
| M0-A03 | 部分 | 进程崩溃三个点已测；派发去重依赖消费者按 eventId 去重；掉电未测 |
| M0-A14 | 符合预期（状态层） | control-plane 套件 |
| M0-A04 | 部分 | 真实 UID 420 编辑、控制面接线、原生用量与 UID 421 签名 Gate 已跑通固定任务；原生执行前持久 ACK 仍未暴露，不扩大为完整 Runtime 承诺 |
| M0-A07 | 部分 | Seatbelt 正式测试 28 通过、2 notRun；选定公网端点外可达内拒绝，独立 root harness 已验证两项跨账户文件拒绝，但完整凭据/设备/签发服务边界仍未验收 |
| M0-A09 | 部分（构建/安装探测） | 基线加两条 checksum 修复构建成功；实际安装包摘要一致；同版本替换 JS 后拒绝；恢复、卸载与设备关闭已核对。尚未形成独立 Broker/Gate 证据 |
| M0-A12 | 部分（有限真实任务） | UID 421 的 12 用例、8 组签发正反例、实际签名离线时效/缺失/损坏负例及 CLI 固定部署接入已通过；注册仅限原 Goal/Run，不代表整阶段 Gate。时效接收代码 update9 已安装未执行，旧成功 Run 与新 bundle 分别绑定 |
| M0-A08 | 部分 | 语义操作、stale guard、前台拒绝已有局部证据；真实 Broker 实验已覆盖入口租约/fence 与清理失败隔离，OS 独占及撤权仍未完成 |
| M0-A10 | 部分（真实本机安装渠道） | 真实一次安装后丢失回执、查询不可用时不重派、恢复查询核对原操作已通过；仍缺正式 Run/Gate 绑定与完整恢复证明，不因选择本机模拟器渠道而要求远端商店 |
| M0-A11 | 部分（本机协议） | 独立进程 SQLite journal 的重启、提交后杀进程、旧 fence 与重复派发拒绝已测；实际独立故障域尚未部署，正式验收保持 blocked |
| M0-A13 | 部分 | 成功任务从持久记录与实际产物重建上下文 ready，预算与历史 Run 保留；丢弃原生会话、大输出、重复错误与用量/重试归总的整组验收未齐备，未知执行不因重建而授权恢复 |
| M0-A05/A06 | 部分（本机停止与恢复） | 本地派发与停止协议、专用 UID/setsid 探针及真实停止核对已有证据；外部作业与完整取消/暂停/失联恢复矩阵仍未验收 |
| M0-A15 | notRun（完整验收） | M1 类型化输入与必需能力尚未全部冻结和实测，不将有限代码任务成功作为 M1 进入门通过 |

本轮还修复评测入口：退出码 0 为通过、1 为断言失败、2 为环境阻塞/未执行、3 为执行器异常；后三种都不能计作通过。复用 `--out` 不再接受旧 JUnit，缺依赖、runner 错误等路径也输出结果和证据清单。`bun test` 本身对 skip 返回 0，不能替代 `bench` 的阶段判定。

M0 阶段检查入口拒绝缺证据、错误签名、过大结构化证据、输出覆盖及未提交源码。有限 signer 的部署证明已由 root 从原受保护文件生成索引，CLI 核对公钥、安装/源码 pin 和实际签名；普通 UID 实测精确 Goal/Run 注册成功，异 Goal/Run 拒绝注册，三组仍为 `blocked`、15 项 `notRun`。新报告位于 `.bench/m0-fixes/verifier-deployment-cli-actual/`，没有伪造 A01–A15 清单。旧阶段报告保持原样，使用方式见 [检查入口与当前边界](verification-entry.md)。

## 5 首验准备与待冻结输入（Decision Register）

用户已选 **iOS 模拟器**，此前 Android 首验候选已被替代。合同 fixture 中的 Android 样例仅用于正反例测试，不代表实际首验平台。

| 项目 | 本轮事实 / 状态 |
| --- | --- |
| 平台 | 已选 iOS 模拟器；不以此宣称真机验收通过 |
| 设备环境 | 已新建专用 iPhone 17 Pro / iOS 26.0，UDID `62F1C107-7480-41BD-B2E2-6C3323B8ECDA`；本地 Broker 协议实验已绑定该设备，生产 OS 独占与 M1 业务 fixture 尚未冻结 |
| Loopit 基线 | `leap_loopit_rn`，`release/1.3.50`，commit `9874bd473cfb3f9603bb580a2085e68983eb98fa` |
| 独立工作副本 | `.bench/workspaces/loopit-m0-ios` 已创建；未在原工作目录执行本轮开发 |
| 构建 | JS 依赖、锁定 Ruby 3.3.11 / Bundler 2.5.23 / CocoaPods 1.16.2 已安装；冻结安装通过（234 pods）。原基线两个本地 Podspec 校验值过期，独立副本修正两行，补丁留在 `.bench/m0-fixes/ios-local-podspec-checksums.patch`；ReleaseTest 模拟器构建已成功，因此属于“基线 + checksum 补丁”的构建，不能称为原样基线重现 |
| 构建产物身份 | `.bench/m0-fixes/ios-derived-data/Build/Products/ReleaseTest-iphonesimulator/Loopit (Test).app`；bundle `com.seedleap.loopitapp.test`，version `1.3.50`，build `98` |
| 安装与设备验证 | 安装身份、替换拒绝、恢复与卸载已测；新增一次安装/查询、丢回执后不重派与清理隔离实验已完成并关机。即时截图不证明页面就绪，OS 独占及正式 Run/Gate 绑定未通过 |
| 首个真实小功能及验收条目 | **用户已确认**诊断信息页：设置入口；显示并复制版本、构建号、环境；不含账号/token；返回与大字体正常。M1 的机器化验收与资源引用仍需完成 |
| 模型提供方与凭据引用 | **用户已确认**沿用现有 gpt-6.1；预览服务实际 ID 为 `openai/gpt-6.1-sol`，认证为现有 OpenCode OAuth。凭据只通过本机受控引用解析，不进入仓库或报告 |
| M0 模型实验预算 | **用户已确认**最长 60 分钟、最多 3 次修复；随后明确允许 OAuth 套餐模式，真实 token 计量、美元费用 `unknown`，替换“费用不可可靠获取则停止”。不能声称已验证原先建议的 10 美元封顶；M1 观察窗口仍需形成具体标准 |
| 交付及恢复范围 | **用户已确认**仅本机 iOS 模拟器 `.app` 产物、安装、验证、卸载或恢复基线包。此选择不免除 T05 的操作核对与恢复实验，也不代表外部内测渠道能力通过 |
| macOS 专用 Worker / signer 账户 | UID 420 / 421 已创建审计；跨账户文件拒绝、实际 Worker 执行及有限 UID 421 签发均通过。Supervisor 清理专用进程及 user 域，临时 access 副本已移除；CLI 部署证明已按原 Goal/Run 限定注册，整阶段签发仍待完整证据 |
| 独立恢复日志部署 | 本机协议实现和故障测试已通过；仍需另一台机器或独立存储的明确配置引用，尚未部署，不能用本机第二个数据库冒充独立故障域 |
| 沙盒方案 | **已定**：macOS Seatbelt + 专用低权限账户（ADR-0003）；完整 conformance 未通过 |
| 产品模型 Project → Task → Run → Delivery | 公开 API 冻结前确认，不阻塞当前基础实验 |

以上人类输入已确认，后续技术接入继续自主推进，不增加逐阶段人工批准。仍需将输入落为带摘要的实际设备、策略、验收及资源引用，并完成各项真实实验；这份决策表不等于已经通过最终体检的 M1 GoalSpec。

现已整理 [M1 输入草案](m1-inputs/README.md)，只读核对 **15/15** 本机材料摘要、源码基线及两行准备补丁，5 条用户功能验收原意保持不变。正式 GoalSpec 解析仍因缺失 policyRef、完整 budgets 和 costBudgetRef 被拒绝；准备报告明确列出工程接线与未冻结标准，不能据此启动 M1。复核入口为 `bun script/m0/validate-m1-inputs.ts`，材料一致但条件未齐时返回 2。
