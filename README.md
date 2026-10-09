# Loopit 移动端自主研发工作台

以 **OpenCode** 为唯一开源主工程和 Agent 运行时，为 Loopit 建设自主研发工作台。人设定目标与验收标准，系统完成需求、设计、开发、验证、内部交付和运维观察。

当前处于 **M0 实施中，尚未通过阶段验收**。OpenCode 锁定为 `v1.18.35`，底座源码未修改。工作台开发与测试使用 **Bun 1.4.2**：旧 1.3.14 的额外子进程管道与 SQLite 组合会触发 macOS `EXC_GUARD`，已通过不依赖工作台代码的样本复现；1.4.2 的同组 36 文件单进程回归为 **358 通过、0 失败、1 未执行，2,193 条断言**，四组各 80 轮最小复现也全部通过。已部署的受保护 M0 环境仍需迁移与复验，本机测试不代表完整设备、沙盒或阶段验收。实测范围见 [工具链记录](docs/m0/workbench-toolchain.json)、[能力矩阵](docs/m0/opencode-adoption.md)及 [检查入口](docs/m0/verification-entry.md)。

设备能力复用 **mobile-ui-runtime**，固定提交 `04975ff4e63f3448e19e8c5ec1c6394dd12a1ad1`，许可证 MIT。OpenCode 负责模型与 Agent 循环；mobile-ui-runtime 提供设备会话、语义观察、revision 校验、原子动作、生命周期和取证，其底层 provider 沿用 agent-device。工作台维护外层任务授权、预算、OS 隔离、恢复账本和正式验收证据。接入使用通用核心及 provider，不加载该库的 DSH 插件或模型配置。其协作队列与最佳努力日志不能替代工作台的持久授权、独立恢复日志或设备 OS 独占证明。

实际已跑通 `Delivery → OpenCode 编辑 → Supervisor 停止核对 → 独立 Verifier → Gate → Delivery`：Worker UID420 修改固定函数，Signer UID421 的 **12 个用例通过**，签名及产物绑定核验后任务成功，原失败 Run 保留。成功 Run 有 5 个原生模型步骤、14,583 reported tokens、美元费用 unknown；一次早先派发的用量未知，不能将可观测部分冒充全程总量。此结果只证明代码合同，不是 Loopit 诊断页交付。独立的无模型 [控制矩阵](docs/m0/control-matrix.md)也已通过真实暂停、冷读、显式恢复、取消及双账户停止核对，恢复没有重置截止时间。[控制器失联实验](docs/m0/owner-loss.md)实际杀掉控制器，并证明旧 Worker 尚存活时冷恢复拒绝重复派发；未知执行仍保留隔离，未实现自动解锁。设备 OS 独占、正式设备 Run/Gate、独立故障域恢复与完整阶段证明仍未完成。

```text
bun --version  # 工作台要求 1.4.2；setup 在改动链接前核对版本
git submodule update --init --depth 1 vendor/opencode
git submodule update --init vendor/mobile-ui-runtime
(cd vendor/opencode && bun install --frozen-lockfile --filter '@opencode-ai/core' --registry https://registry.npmjs.org --network-concurrency 4)
bun script/setup.ts
bun run typecheck
bun test ./script/test
bun script/bench.ts verify --suite contract-core --dataset contract-core/1
bun script/bench.ts verify --suite control-plane
bun script/bench.ts verify --suite recovery-journal-local
```

使用 [Bun 官方发行版本](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) 安装所需工具链。本机已校验的独立副本位于 `.bench/toolchains/bun-1.4.2/bun`，可用该路径执行上面的工作台命令；它未覆盖全局 Bun、OpenCode 二进制或 root 已部署的运行环境。上游 `vendor/opencode/package.json` 的历史工具链声明原样保留。

| 目录 | 内容 |
| --- | --- |
| `vendor/opencode` | 锁定的 OpenCode 底座（submodule） |
| `vendor/mobile-ui-runtime` | 锁定的移动设备工具库（submodule），复用通用核心、动作语义和 provider；原独立工作区的未提交改动不纳入 |
| `packages/contracts` | GoalSpec、StageResult、Evidence、GateDecision 等合同 schema、交叉校验与固定样本 |
| `packages/delivery` | 基于 OpenCode `EventV2` 与 SQLite 的交付状态、outbox、操作账本及 Runtime 派发接线；事务迁移及 FULL 耐久配置 |
| `packages/recovery-journal` | 我们维护的恢复日志协议、独立 SQLite/CLI 实现与故障测试；尚未部署独立机器 |
| `packages/sandbox` | Worker 沙盒接口与 macOS Seatbelt 后端；已部署专用 Worker/Signer，设备直连隔离仍需补齐 |
| `packages/runtime` | 我们维护的 OpenCode CLI 生命周期接线、执行预算与停止核对；直接沿用原生 Agent 循环 |
| `packages/verifier` | 独立验证、签名消费及固定 root 部署信任接入；当前真实签发器只覆盖固定代码合同 |
| `script/macos/setup-worker.sh` | 默认只审计专用账户；`--dry-run` 输出计划，仅显式 `sudo … --apply` 创建缺失账户 |
| `script/bench.ts` | 套件与 M0 阶段检查入口；校验真实证据、签名、冻结费用政策，输出机器报告 |
| `script/m0/runtime-edit-probe.ts` | 有界真实编辑实验；默认仅准备，显式 `--run` 执行一次原生 CLI，最多 3 个模型轮次 |
| `script/m0/ios-*` | 构建产物/安装核验、设备语义实验，以及我们维护的只读前台状态适配与 agent-device Runner 最小补丁 |

- [规格文档索引](docs/README.md)
- [OpenCode 选型决策](docs/decisions/0001-opencode-base.md)
- [交付状态存储决策](docs/decisions/0002-delivery-state-on-opencode-store.md)
- [macOS Worker 沙盒决策](docs/decisions/0003-macos-worker-sandbox.md)
- [M0 选型记录与能力矩阵](docs/m0/opencode-adoption.md)
- [iOS 构建与安装实验](docs/m0/ios-simulator.md)
- [阶段检查入口与账户实验](docs/m0/verification-entry.md)
- [真实暂停、恢复与取消实验](docs/m0/control-matrix.md)
- [控制器失联与旧 generation 拒绝实验](docs/m0/owner-loss.md)
- [过期证据的只读部署复验](docs/m0/readonly-acceptance.md)
- [M1 诊断页输入草案与未冻结项](docs/m0/m1-inputs/README.md)
- [产品、四层架构与 harness 边界](docs/loopit-workbench-spec.md)
- [执行与交付契约](docs/execution-contracts.md)
- [验收与评测](docs/acceptance-spec.md)
- [M0–M3 实施规格](docs/milestones/README.md)
- [参考资料与选型依据](docs/reference-and-selection.md)

用户已选择 **iOS 模拟器**作为首验平台，首个真实功能是设置中的诊断信息页，模型沿用已配置的 `openai/gpt-6.1-sol` OAuth 登录。M0 模型实验限制为 60 分钟、最多 3 次修复；记录 token，美元费用为 unknown。交付限本机模拟器 `.app`、安装验证及恢复基线包。

M1 另行确认了完整交付 **120 分钟、最多 3 次修复**，最大系统辅助功能字号，安装后观察 **30 分钟、10 次完整操作**。这不延长已经结束的 M0 模型实验，也不代表 M1 已获阶段准入；设备、受保护用例、策略和渠道引用仍须完成冻结。

候选环境为本机 iPhone 17 Pro / iOS 26.0；Loopit 基线为 `leap_loopit_rn` 的 `release/1.3.50`，commit `9874bd473cfb3f9603bb580a2085e68983eb98fa`，独立工作副本位于 `.bench/workspaces/loopit-m0-ios`。ReleaseTest 模拟器构建已成功，产物位于 `.bench/m0-fixes/ios-derived-data/Build/Products/ReleaseTest-iphonesimulator/Loopit (Test).app`，bundle 为 `com.seedleap.loopitapp.test`，版本 `1.3.50`、build `98`。构建使用该基线加独立副本中两条本地 Podspec checksum 修复，不能称为原封不动的基线重现；安装内容摘要、同版本 JS 替换拒绝、原包恢复和跨重启卸载核对已实测；语义点击、stale guard 及只读前台状态拒绝均有局部证据，仍不代表设备独占或完整 Broker。已确认的人类输入仍需落为可冻结的类型化目标与资源引用。具体进度与缺口以 M0 能力矩阵为准。

浏览器、手机 App、桌面 App 共用同一底座；不并行拼装第二套 Agent 平台，也不以 Claude Agent SDK/Claude Code 核心作为必需依赖。

过往工程仅作为参考及工具扩展候选。文档中的本地参考路径用于记录来源，相关外部文件未随本仓库发布。
