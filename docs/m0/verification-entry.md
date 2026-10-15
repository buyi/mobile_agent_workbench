# M0 检查入口与当前边界

`bench verify` 执行一个合同套件，`bench milestone check` 判断整组 M0 证据是否齐备。单套件、单次编辑、一次安装成功都不能代替阶段验收。

## 检查阶段证据

```sh
bun script/bench.ts milestone check --milestone M0 \
  --manifest '<milestone/1 JSON file>' \
  --attestation '<m0-attestation/1 JSON file>' \
  --goal '<frozen goal/1 JSON file>' \
  --cost-policy '<cost-policy/1 JSON file>' \
  --run-id '<expected Run ID>' \
  --trusted-public-key '<operator-configured Ed25519 public key PEM>' \
  --verifier-id '<trusted verifier ID>' \
  --artifact-root '<evidence directory>' \
  --out '<new separate report directory>'
```

这些尖括号是命令说明中的参数位置，不是可运行的冻结目标。检查器校验 A01–A15 全部必需，核对目标/验收/Run/源码/spec 绑定、文件内容摘要、路径、有效期、完整用例结果、能力矩阵和资源清理。声明为 passed 但没有实际证据文件不会通过；大于结构化输入上限的 JSON 也不能静默跳过。

签名信任锚不能由被检清单自带。仅传 `--trusted-public-key` 可以检查签名，但不能建立独立部署身份。本机 UID 421 Verifier 的真实部署现已通过 `--verifier-deployment /private/var/loopit/verifier-deployment-export/manifest.json` 接入：CLI 从固定 root 索引 `/private/var/loopit/verifier-deployment-trust.json` 读取公钥 pin、安装与源码摘要、成功 Run 和停止证明，逐一核对 17 份导出材料及实际签名。索引由 root 从原受保护安装/历史文件生成，提交材料不能选择其他信任根，也没有“已独立”的布尔开关。

注册严格限定索引中的 project/task/Goal revision/Goal digest/验收摘要/Run。2026-10-09 的普通 UID 实测位于 `.bench/m0-fixes/verifier-deployment-cli-actual/`：`exact/result.json` 的 `requestedScopeRegistered=true`、`independentVerifierEstablished=true`；`wrong-run/` 与 `wrong-goal/` 均为 false。三者的 M0 结果仍是 `blocked`，15 项均 `notRun`，因为这次只验证部署接入，没有提交完整阶段清单。固定代码任务的注册不能给其他 M0 或 M1 Goal 背书。信任索引摘要为 `sha256:9f8fb6660e34e9731420fa4f6435aed9e4e8a958245e475fc347d069a4b380be`。

历史检查时源码尚未提交，报告包含 `source_dirty`；之后提交源码不能追溯改变那次报告的源码身份。一个 HEAD SHA 无法代表未提交源码。输出目录必须全新且与证据及直接输入不相交，避免检查过程覆盖证据。失败后使用新的报告目录复验。

费用政策独立输入，并核对其真实文件 SHA-256 等于冻结目标 `costBudgetRef` 的 pin。用户已允许本次模型实验使用 OAuth 套餐、费用 unknown，政策文件为 [model-experiment-cost.json](model-experiment-cost.json)，没有美元硬上限；60 分钟和最多 3 次修复另由执行预算限制。unknown 保留原义，不能折算成 0 或声称 10 美元封顶已验证。若以后冻结政策含 USD 硬上限，未知费用就不能证明预算满足。

保留的阶段检查报告为 `.bench/m0-fixes/milestone-check-hardened/result.json`，生成于下述主链路成功之前，结果是 `blocked`，当时 A01–A15 均未收到整体验收证据。后续局部证据已经增加，但完整阶段证明尚未齐备，M0 仍为 `blocked`；不能把这个旧报告当成新实验的复验结果。

## 已通过的有限主链路

2026-10-09，本机已跑通 `Delivery → WorkerDispatch → OpenCode → Supervisor 停止核对 → 独立 Verifier → Gate → Delivery`。成功范围为固定 `sumEvenThrough.ts` 代码任务 `M0-CODE-01`，不是 Loopit 诊断页，也不是 M0 整阶段。归档根目录为 `.bench/m0-fixes/control-loop-actual/code-task-passed/`：

| 证据 | 实际结果与范围 |
| --- | --- |
| `status.json`、`reports/result.json` | Task `m0-code-loop-20261009a`、Run `run-46a51a51-d1ce-45f2-83f6-719cc4fc2bb8` 成功；既有失败 Run 保留原终态，事件回放与投影一致 |
| `reports/verification-evidence.json`、`signed-check.json`、`gate.json` | UID 421 signer 验证 12 个固定用例，签名绑定目标、验收、Run、候选与证据摘要，可信父进程验签后接受该任务的 delivery Gate；候选在无密钥、禁网子进程内执行 |
| `reports/recovered-context.json` | 从持久任务、派发记录及实际产物重建上下文，`status=ready`、`issues=[]`；重建解释性上下文不等于授权恢复未知执行 |
| `status.json` 的 Supervisor 证明 | Worker UID 420 与 signer UID 421 进程均为空、专用 `user/<uid>` 域不存在；证明范围是专用本机 UID，不代表远端作业或设备状态 |
| `reports/execution.json` | 原 60 分钟绝对 deadline `2026-10-09T11:08:25.455Z` 未重置；成功 Run 的 `repairIndex=2`、`maxRepairs=3` |

8 组 signer conformance 已通过：已知正确/错误候选、缺候选、错误候选摘要、错误 Run、调用者自带公钥、重复请求、签名载荷篡改。报告位于同一归档根的 `run-history/run-3c531003-ad06-4117-821a-384194cd5158/reports/signer-conformance-0061b3d3-6878-41ef-a44d-74f1ca5876d4.json`。这是有限 fixture 签发器的真实调用结果，不扩大为通用代码或整组 M0 的签发能力。

成功运行之后补了 `acceptSignedFixtureCheck`：使用受保护 Run 的起点和原 deadline，核对签名时间、Gate 时间与证据完成时间，并拒绝未来、早于 Run、过期、缺失、损坏或错误绑定。在真实 `11:08:15.112Z` 用原签名/证据接受正例，通过注入 `deadline+1ms` 时钟拒绝过期，未重签也未调用模型，见 `.bench/m0-fixes/control-loop-actual/offline-verification-audit.json`。update9 已安装新 controller，但未执行；成功 Run 绑定旧 controller `e168dbdb…`，当前安装为 `cffa2e4e…`。root 索引分别保留两者，历史核验使用实际成功记录的接收时间，不把新检查倒算成旧代码当时已有的能力。

后续 [A12 只读接收复验](readonly-acceptance.md) 已在独立安装目录完成：root 在禁写、禁网、禁止 fork 的 Seatbelt 中调用新只读入口，以真实当前时间收到精确的 `evidence_acceptance_rejected:acceptance_deadline_exceeded`，退出码 2；9 份原始输入和 update9 字节均未改变，独立审计 43/43 通过。它没有执行旧 update9 finalizer、数据库、Runtime、Signer 或模型，也没有续期原预算。此前 `-c` 安装因把公开导出的 JSON 格式摘要误当成原始报告字节摘要而拒绝，失败现场保留；修正为分别核对两种原字节及签名后，`-d` 复验才执行。A12 剩余完整 15 项证据装配，不能据此称 M0 已通过。

成功 Run 的原生记录有 **5 个 model steps、14,583 reported tokens**，USD 费用为 `unknown`，原生 reportedCost=0 不能解释为免费。第二 Run `run-582a99fb-0203-4c02-bfe9-4c9a0803c2d5` 的派发结果曾不明，停止核对后以 failed 结案，其模型用量仍为 `unknown`；不能声称它未调用模型，也不能把两个有观测记录的 Run tokens 相加冒充全程已知总用量。原生 steps 数也不代表供应商内部重试次数已知。

后续 [A05 控制矩阵](control-matrix.md) 已在 generation 16/17 完成真实暂停、冷读、恢复、取消及双 UID 停止证明，独立审计 83 项通过。[A06 owner 丢失实验](owner-loss.md) 又在 generation 18/19 证明：controller 实际被杀而旧 Worker 仍活着时，未 ACK 事件冷重放保持 unknown、prepare/start 均为 0；随后停止核对及旧 scope/generation 拒绝通过，独立审计 105 项通过。这些固定无模型 fixture 没有释放未知 reservation，也不支持自动解锁 unknown 执行。

`runtime-contract` 现在可以执行上述部署证据的汇总。命令为 `bun script/bench.ts verify --suite runtime-contract --evidence-root .bench/m0-fixes --out <新目录>`；检查器读取固定的成功交付、A05 独立审计和 A06 owner-loss 独立审计，核对各自 sourceArtifacts 的字节摘要、审计条目、状态与明确边界，并生成 `runtime-contract-inputs.json`。2026-10-15 的本轮执行结果为 3 passed / 0 failed / 0 notRun，最新报告位于 `.bench/m0-process-20261015/runtime-contract-after-pin-guard/`。没有提供 evidence-root 时会 blocked；文件缺失、摘要不符、审计失败或边界字段不符合预期时不会通过。

这个套件是三份历史部署证据的可重复聚合，不会重新执行模型、Supervisor、设备或管理员实验，也不为这些报告建立新的独立信任锚。报告仍明确 `milestonePassed=false`、`M1` 未实施、未知执行 reservation 不自动释放。它不能替代受信任的 M0 阶段签名、A01–A15 完整材料或 M0 Gate；A06 的拒绝路径已核验，不等于一般场景的自动恢复。

## 本机模拟器渠道实验

本机 iOS 模拟器安装是用户选定的真实交付渠道。`.bench/m0-fixes/ios-broker-actual-v1/result.json` 已记录一次真实安装及一次恢复查询：安装全包字节匹配，故意丢弃 Ledger 回执后保持 indeterminate；查询口故障期间拒绝重派及换 operationId 绕过，恢复查询后核对原操作。清理故障触发 quarantine，随后真实卸载、确认 App 不存在、关机并确认 Shutdown，最终租约 released。

同目录 `evidence-audit.json` 核对 51 份引用文件摘要及持久状态。故障均明确标注为边界注入；SQLite 租约只约束 Broker 入口，相同 OS UID 仍可直连 simctl，不能宣称 OS 独占。该实验尚未绑定正式 Task/Run 与签名 Gate，因此不能替代完整 A08/A10；缺口不是必须发布到远端商店。入口与限制见 [设备实验说明](../../script/m0/IOS-BROKER-EXPERIMENT.md)。

## macOS 账户实验

[account-isolation-probe.py](../../script/macos/account-isolation-probe.py) 默认只输出计划。`--provision` 在明确管理员执行时调用账户配置脚本、复核属性，再运行非秘密文件实验；`--run` 只审计已有账户并运行实验。

本机已通过 macOS 原生管理员认证执行：Worker UID 420、signer UID 421。root 调度的每个正例先确认实际账户 UID，再读取对应账户新建的私有测试文件；负例由 Worker 直接读取相同文件，核对明确权限拒绝，没有使用 Seatbelt 掩盖缺失账户或不可用工具。Worker 不获得 sudo 权限。三个临时文件已清理，账户保留供后续部署。

账户实验报告为 `.bench/m0-fixes/account-isolation/result-audited.json`，包括完整账户审计与两项跨账户拒绝。该报告验证的是这些明确文件的边界，不代表操作者目录内所有文件都不可读；后续有限 signer 的真实部署和签发事实由上述主链路另行证明。

macOS 管理员进程可能无法读取 Documents 中的脚本。账户实验把两份脚本复制到临时安装目录，核对字节摘要一致后执行。后续 Worker/Supervisor 已部署，真实无模型探针覆盖 leader、`setsid` 后代、旧 scope/generation 与停止阶段拒绝；报告保留在上述归档的首个 Run 历史中。不能把这些明确范围的部署实验直接改写为原 `sandbox-contract` 所有用例通过。

## 本地恢复日志与后续接线

2026-10-13 用户明确选择本机 SQLite，取消第二台主机、SSH 和独立故障域作为 M0 前置；规范变更见 [ADR-0004](../decisions/0004-local-sqlite-recovery.md)。复用 `packages/recovery-journal` 的现有 JournalStore、单请求 CLI 和本地子进程传输，不另建恢复平台。

`bun script/bench.ts verify --suite recovery-journal-local` 测试单独 SQLite、真实子进程、fence 推进与重复派发拒绝。Journal 保存派发预约与当前权威；业务数据库恢复旧快照时保留最新 Journal。所有连接要求 WAL/FULL，提交完成才回 ACK；缺日志、回执丢失或外部状态不明时阻断重复派发。SSH 适配及其离线测试保留为可选能力，不要求用户配置远端。

这些局部测试与 A05/A06 的真实停止、冷恢复拒派、本机设备安装回执核对分别保留原来的证据范围。`recovery` 正式套件仍为 blocked，剩余工作是受保护本机日志与 Task/Run/渠道的正式接线、设备 OS 独占、A01–A15 完整阶段证据和签发。正常主机重启尚需实测；整机/磁盘损坏后的异机恢复移出本期，不由本机测试推定通过。

旧报告按生成时的规格和源码原字节保留，包括曾因缺独立主机而 blocked 的结果。范围调整不追溯修改旧签名、旧 specDigest 或旧失败记录。M1 类型化输入和诊断页仍需完成；有限代码任务通过不能替代 M0 准入。部署与调用方法见 [RecoveryJournal](../../packages/recovery-journal/PROTOCOL.md)。

### 2026-10-13 本机 SQLite 接入复验

新增 `createRecoveryJournal({ journalId, local: { cliPath, databasePath, ownerId } })`，直接复用已有本地 CLI 与 JournalStore；显式 transport 注入继续兼容，两种配置不得同时提供。没有新建第二套存储、自动初始化丢失的日志或给未知动作添加重试。

| 验证 | 实际结果 | 范围 |
| --- | --- | --- |
| 全部 `recovery-journal-local` | 33 passed / 0 failed / 0 notRun | 包含原本地协议、可选 SSH 离线兼容及新增真实本地 CLI → OperationLedger 接入；没有远端连接 |
| 本机 Journal 与 Ledger 定向回归 | 36 passed / 0 failed，429 断言 | 与上一行有重叠，不累加；提交后许可、丢 ACK 后冷重启/推进 fence 仍不重派，缺 DB/错误身份拒绝 |
| M1 输入一致性 | 17 passed / 0 failed，47 断言 | 本机策略和引用已更新；不允许删除 M0 Gate、回滚 Journal、关闭 fence 或盲重派 |
| TypeScript | 通过 | 修改后的代码与输入校验可编译 |
| M1 准备报告 | exit 2 / blocked | 材料、引用和 Case Pack 一致，受保护发布与阶段准入仍未完成，`deliveryRunAllowed=false` |

本机报告：[完整 Journal 套件](../../.bench/m0-fixes/local-sqlite-full-suite-20261013/journal/result.json)、[本机工厂与 Ledger](../../.bench/m0-fixes/local-sqlite-default-20261013/result.json)、[M1 输入与旧 readiness 归档](../../.bench/m0-fixes/local-sqlite-policy-20261013/result.json)。本次没有模型、管理员、真实设备或 SSH 连接操作，没有重启这台 Mac，未修改现有受保护运行部署。本机恢复接入已验证，完整 M0 仍待正式链路与阶段证据收口。

## 最新本地回归快照与稳定性缺口

2026-10-09 的 [checkpoint v4 汇总](../../.bench/m0-fixes/checkpoint-validation-v4/summary.json) 对同一组 36 个测试文件逐一启动独立 Bun 进程，每个进程使用 `/private/tmp` 下独立 HOME/XDG/TMPDIR，最多并行两个：**358 passed / 0 failed / 1 notRun，2,193 条断言**；typecheck 退出码 0，执行前后 233 项源码及 submodule 状态清单一致。这是文件级隔离回归，没有替换旧实际 Run 的源码身份。

| 范围 | passed / failed / notRun | 断言 |
| --- | --- | --- |
| contracts | 104 / 0 / 0 | 196 |
| delivery | 90 / 0 / 0 | 859 |
| runtime | 24 / 0 / 1 | 141 |
| verifier | 17 / 0 / 0 | 105 |
| recovery-journal | 29 / 0 / 0 | 351 |
| script/test | 94 / 0 / 0 | 541 |

唯一未运行项是原版 OpenCode 真实二进制 version/help 的 opt-in 检查；`restricted.test.ts`、`ios-state-adapter.test.mjs` 和 sandbox 套件明确排除，未计入通过。Python 协议 fixture 另有 [65 项历史回归](../../.bench/m0-fixes/python-protocol-regression-v1/counts.json)；之后 live-device probe 的两处修改以 [21 项独立复验及 stage-b 摘要](../../.bench/m0-fixes/worker-live-device-independent-review-b/result.json) 为准，不把旧批次扩大成修改后全部重新实测。两组 Python 检查均未执行管理员或真实设备操作。

失败记录未覆盖：v1 在缺失 JUnit 时解析崩溃，未保存 Bun 的退出码，不能由已打印的通过项推断整套通过。v2 补强 driver 后实际记录到 `SIGKILL`、非超时、无 JUnit；[系统诊断摘录](../../.bench/m0-fixes/checkpoint-validation-crash-diagnostics/result.json) 明确为 `EXC_GUARD / GUARD_TYPE_FD / CLOSE`，不是已证实的 OOM。在该次检查时，错误关闭的来源尚未定位，未归因于 Bun 或某段应用代码；后续独立复现见下一节。v3 独立进程回归得到 341/17/1，17 项均因 SSH fixture 的临时路径经过用户目录 ACL 被正确拒绝；移至私有临时目录后 v4 全部通过，生产防护与测试断言未放宽。分别见 [v1 留档说明](../../.bench/m0-fixes/checkpoint-validation-v2/v1-preserved-failure.json)、[v2 失败](../../.bench/m0-fixes/checkpoint-validation-v2/result.json)、[v3 失败](../../.bench/m0-fixes/checkpoint-validation-v3/result.json)。

新 driver 先保存退出码、信号、超时和执行异常，再解析 JUnit；缺失、损坏、空报告、非零退出和报告与终端统计不一致都失败关闭，另有 5 个真实子进程负例。文件级回归本身没有解决该崩溃；后续定位与工具链对照如下。

## Bun 额外管道缺陷与工作台工具链变更

独立样本只使用 `node:child_process`、`bun:sqlite` 和垃圾回收，没有导入工作台代码。Bun 1.3.14 的无额外管道对照完整运行 80 轮；三种 `stdio[4]` 使用方式分别在 3、10、3 个子进程关闭回执之后触发 `EXC_GUARD / GUARD_TYPE_FD / CLOSE`。完整回归的文件描述符观测还确认，出错编号已被重新用于测试数据库的 WAL 文件。证据见 [最小复现结果](../../.bench/m0-fixes/extra-stdio-minimal-v1/conclusion.json)；未隔离具体的 Bun 原生修复提交，不能把未符号化堆栈说成精确源码定位。

[Bun 1.4 官方说明](https://bun.sh/blog/bun-v1.4) 记录了额外 stdio 描述符重复关闭的修复。使用从官方固定 release 下载并校验 GitHub 资产摘要的 1.4.2，原样样本四模式各 80 轮均完成，320 个子进程退出。未修改项目代码的同组 36 文件单进程回归，首轮 353/0/6；补入原有公开签名归档后第二轮 **358 passed / 0 failed / 1 notRun、2,193 断言**，执行前后源码清单一致。首轮五项签名样本未执行的事实保留，结果不混算。报告见 [版本对照](../../.bench/m0-fixes/bun14-binary-comparison-v1/result.json)。一次尝试清理重复 `destroy()` 的应用层候选仍然崩溃，已完整撤回，没有将无效改动留在 Runtime 中。

因此本仓库开发/测试宿主固定到 Bun 1.4.2，并增加独立子进程的额外管道/SQLite 回归。版本拒绝发生在 `setup` 修改依赖链接之前。官方来源和 macOS arm64 二进制摘要记录在 [workbench-toolchain.json](workbench-toolchain.json)。全局 Bun、OpenCode 的固定源码与二进制、历史 root 安装、旧 Run 与签名均未改写。**上述版本对照完成时，受保护环境仍使用旧宿主，需另行部署新版本并复验控制、停止、恢复和签发链；版本对照不等于部署修复或长期稳定性验收。**

## 2026-10-12 后续验证

本节保留 2026-10-12 当时的结果及缺口。2026-10-13 用户已取消独立恢复主机要求，当前本机 SQLite 范围以上节和 ADR-0004 为准；原实验及报告未重写。

本轮从提交 `10712cf` 执行，无模型调用。历史报告保留，以下是新增证据：

| 范围 | 实际结果 | 边界 |
| --- | --- | --- |
| mobile runtime、设备命令端口与准入 | 24 测试通过，152 断言 | 本机协议验证，未接通正式设备 Task/Run/Gate |
| Bun 1.4.2 受限执行 | 12 测试通过，68 断言，包含实际 Seatbelt 内核身份探测 | 普通账户的真实 OS profile，不代替完整跨账户部署 |
| RecoveryJournal 与 OperationLedger | 49 测试通过，471 断言 | 本地及离线 SSH 合同；没有独立主机配置，远端部署未执行 |
| UID422 临时模拟器与 UID420 绕过负例 | 实际执行，独立审计 52/52 通过 | 默认列表、已知 UDID 重命名、明确私有路径三条 CLI 入口；未证明所有原生 IPC 或正式代理链 |
| 新 Bun 1.4.2 受保护控制矩阵 | 两轮实际执行，独立审计 118/118 通过 | 新 job 的无模型 fixture；暂停、冷读、恢复、取消、停止及预算不续期，不是全量部署切换 |
| 新 Bun 1.4.2 受保护签发 | 8 组实际正反例通过，UID421 执行 | 新固定签发 job；原密钥仅路径引用，旧配置/信任注册不变，无 Task/Run 状态转换 |

设备实验使用新的临时 UDID，完成 shutdown/delete/空集检查；UID420、421、422 的进程与服务域均有最终停止证据。原控制器的 pending/maintenance 报告保持原字节，最终解释结合相同 scope/generation 的外层停止证明。原先管理员启动从 Documents 导入 Python 失败；改为固定 `/private/tmp` 工作目录与 Python `-I` 后执行体不变，实验才实际启动。

控制矩阵的新 scope 为 generation 22 和 23。第二轮创建新的 Attempt，截止时间与修复预算未变；原模型 Run 三份文件摘要一致。新安装与旧 Bun 1.3.14 任务并存，不修改旧签名、原信任注册或已经过期的模型预算。

证据分别见 [本轮本机命令](../../.bench/m0-fixes/m0-verification-20261012/commands.json)、[受限执行进程结果](../../.bench/m0-fixes/m0-verification-20261012/restricted-runtime-process.json)、[恢复账本复验](../../.bench/m0-fixes/recovery-journal-recheck-20261012-v1/result.json)、[设备实测审计](../../.bench/m0-fixes/worker-live-device-actual-20261012/independent-audit.json)和[新控制矩阵审计](../../.bench/m0-fixes/bun142-matrix-actual-20261012a/independent-audit.json)。

本次 M0 检查入口仍返回 `blocked`。已有签发部署仅注册原 `M0-CODE-01` Goal/Run；它不能替代涵盖全部 A01–A15 的阶段 Goal、清单和独立签名。正式设备执行链、独立恢复主机及完整阶段证据仍不齐备。隔离的 HOME 还暴露出原全局 Git 忽略规则隐藏的 `.DS_Store` 和三份既有 README，检查器据此记录 `source_dirty`；保留该结果，不将常规用户环境下的 clean 状态冒充该次检查的输入。

仓库忽略规则已补充 `.DS_Store`，并显式纳入三份既有协议/输入 README，使源身份核对不再依赖操作者的全局忽略配置。该修正不改变前一次检查报告。设备端口当前的生产 Task/Run 授权、受保护绑定加载及 UID422 执行器仍需接线；本次 CLI 负例通过不能把 fixture 接线提升为正式交付能力。

新签发 scope 为 generation 24：正常候选通过，错误候选、缺失文件、摘要不符、错误 Run、调用者公钥、重复请求和签名载荷篡改均按预期处理。原配置与受保护输入不变，旧密钥未复制，Worker/Signer 最终均停止。新旧受保护部署并存；本轮没有重测新 Bun 下的 controller-loss 窗口，没有把测试包切换成正式设备执行器，也没有改变旧部署信任注册的作用域。

## 2026-10-15 固定工具链复验

本机默认 `bun` 仍报告 **1.3.14**，与仓库声明的 Bun 1.4.2 不一致。没有修改全局安装；从已归档的 Bun 1.4.2 macOS arm64 受保护 fixture 复制到 `/private/tmp` 后，以 `docs/m0/workbench-toolchain.json` 中的二进制摘要 `sha256:35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5` 校验，并确认版本为 1.4.2。

用默认 Bun 1.3.14 运行 `runtime-local` 得到 36 passed / 3 failed / 2 notRun；失败集中在额外 stdio 生命周期回归。用摘要匹配的 Bun 1.4.2、固定 OpenCode 1.18.35 二进制与摘要，并启用实际 Seatbelt FFI 探针后，`runtime-local` 为 **41 passed / 0 failed / 0 notRun**，新增的版本检查器复验见 [1.4.2 runtime-local 复验](../../.bench/m0-process-20261015/runtime-local-bun142-pinned-entry/result.json)。这确认当前宿主入口仍错误地落在 1.3.14；以后正式验证必须显式调用固定 1.4.2，不能只凭 packageManager 声明认定已经切换。

提权 Seatbelt 复验为 28 passed / 0 failed / 2 notRun；未运行项是 operator 与 signer 的独立文件读取基线，因该次套件没有收到两份临时 fixture 参数。报告见 [sandbox-contract 复验](../../.bench/m0-process-20261015/sandbox-contract-elevated/result.json)。这不构成完整跨账户套件通过；已有独立跨账户实验范围与边界仍见前文。以上复验只证明指定宿主和固定输入的 Runtime/Sandbox 子集，不是 M0 Gate，也未启动 M1 Run。
