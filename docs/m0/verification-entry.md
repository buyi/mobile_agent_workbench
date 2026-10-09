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

当前改动尚未提交，检查器也会报告 `source_dirty`；一个 HEAD SHA 无法代表未提交源码。输出目录必须全新且与证据及直接输入不相交，避免检查过程覆盖证据。失败后使用新的报告目录复验。

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

因此 `runtime-contract` 仍输出 `blocked` 的直接原因是该入口尚未实现上述部署证据的可执行汇总，不能再解释成 Supervisor、进程树停止或所有持久恢复均未验证。现有有限证据不升级为一般场景的自动恢复，也不替代完整 M0 清单；A06 的较新结果以 owner 丢失实验为准，A05 矩阵本身没有覆盖该窗口。

## 本机模拟器渠道实验

本机 iOS 模拟器安装是用户选定的真实交付渠道。`.bench/m0-fixes/ios-broker-actual-v1/result.json` 已记录一次真实安装及一次恢复查询：安装全包字节匹配，故意丢弃 Ledger 回执后保持 indeterminate；查询口故障期间拒绝重派及换 operationId 绕过，恢复查询后核对原操作。清理故障触发 quarantine，随后真实卸载、确认 App 不存在、关机并确认 Shutdown，最终租约 released。

同目录 `evidence-audit.json` 核对 51 份引用文件摘要及持久状态。故障均明确标注为边界注入；SQLite 租约只约束 Broker 入口，相同 OS UID 仍可直连 simctl，不能宣称 OS 独占。该实验尚未绑定正式 Task/Run 与签名 Gate，因此不能替代完整 A08/A10；缺口不是必须发布到远端商店。入口与限制见 [设备实验说明](../../script/m0/IOS-BROKER-EXPERIMENT.md)。

## macOS 账户实验

[account-isolation-probe.py](../../script/macos/account-isolation-probe.py) 默认只输出计划。`--provision` 在明确管理员执行时调用账户配置脚本、复核属性，再运行非秘密文件实验；`--run` 只审计已有账户并运行实验。

本机已通过 macOS 原生管理员认证执行：Worker UID 420、signer UID 421。root 调度的每个正例先确认实际账户 UID，再读取对应账户新建的私有测试文件；负例由 Worker 直接读取相同文件，核对明确权限拒绝，没有使用 Seatbelt 掩盖缺失账户或不可用工具。Worker 不获得 sudo 权限。三个临时文件已清理，账户保留供后续部署。

账户实验报告为 `.bench/m0-fixes/account-isolation/result-audited.json`，包括完整账户审计与两项跨账户拒绝。该报告验证的是这些明确文件的边界，不代表操作者目录内所有文件都不可读；后续有限 signer 的真实部署和签发事实由上述主链路另行证明。

macOS 管理员进程可能无法读取 Documents 中的脚本。账户实验把两份脚本复制到临时安装目录，核对字节摘要一致后执行。后续 Worker/Supervisor 已部署，真实无模型探针覆盖 leader、`setsid` 后代、旧 scope/generation 与停止阶段拒绝；报告保留在上述归档的首个 Run 历史中。不能把这些明确范围的部署实验直接改写为原 `sandbox-contract` 所有用例通过。

## 本地恢复日志与后续接线

`bun script/bench.ts verify --suite recovery-journal-local` 测试单独 SQLite、真实子进程、fence 推进与重复派发拒绝；受限 SSH transport 另有离线参数/失败测试，未连接远端。这些与 A05/A06 的真实停止、冷恢复拒派，以及本机设备安装回执核对分别保留明确范围。`recovery` 正式套件仍为 blocked，剩余缺口是独立故障域权威与设备 OS 独占副作用边界；把本机另一个目录或复制的数据库称为独立存储不能解除它。

独立故障域部署需要明确的另一台主机或独立存储配置引用。目前没有选定或连接这样的存储。上线还需由可信传输固定身份，限制业务方调用管理员命令，确保旧业务快照不能回退权威 fence。真实本机安装的回执丢失核对已按上节实测，但使用同机 Journal，不能填补独立故障域缺口。部署协议见 [RecoveryJournal](../../packages/recovery-journal/PROTOCOL.md)。

剩余工作包括：设备 Broker 的 OS 独占与撤权、设备渠道实验与正式 Run/Gate 的接线、独立恢复故障域、A01–A15 完整阶段证据与签发、未知模型用量的诚实处理，以及 M1 类型化输入冻结和诊断页实现。有限 Worker 停止、UID 421 签发、部署身份的限定范围注册、上下文重建及成功 Run 的计量已接通；这些局部成功仍不能替代 M0 整体验收。

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

失败记录未覆盖：v1 在缺失 JUnit 时解析崩溃，未保存 Bun 的退出码，不能由已打印的通过项推断整套通过。v2 补强 driver 后实际记录到 `SIGKILL`、非超时、无 JUnit；[系统诊断摘录](../../.bench/m0-fixes/checkpoint-validation-crash-diagnostics/result.json) 明确为 `EXC_GUARD / GUARD_TYPE_FD / CLOSE`，不是已证实的 OOM。具体错误关闭的来源仍在定位，尚不能归因于 Bun 或某段应用代码。v3 独立进程回归得到 341/17/1，17 项均因 SSH fixture 的临时路径经过用户目录 ACL 被正确拒绝；移至私有临时目录后 v4 全部通过，生产防护与测试断言未放宽。分别见 [v1 留档说明](../../.bench/m0-fixes/checkpoint-validation-v2/v1-preserved-failure.json)、[v2 失败](../../.bench/m0-fixes/checkpoint-validation-v2/result.json)、[v3 失败](../../.bench/m0-fixes/checkpoint-validation-v3/result.json)。

新 driver 先保存退出码、信号、超时和执行异常，再解析 JUnit；缺失、损坏、空报告、非零退出和报告与终端统计不一致都失败关闭，另有 5 个真实子进程负例。**文件级回归通过不等于单进程 guarded-fd 崩溃已修复，也不证明长时间生产运行稳定。** 该问题保留为 M0 整体收口前的稳定性缺口。
