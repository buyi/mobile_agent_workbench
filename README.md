# Loopit 移动端自主研发工作台

以 **OpenCode** 为唯一开源主工程和 Agent 运行时，为 Loopit 建设自主研发工作台。人设定目标与验收标准，系统完成需求、设计、开发、验证、内部交付和运维观察。

当前处于 **M0 实施中**：已完成 M0-T01（OpenCode 锁定为 `v1.18.35`、版本化合同包、沿用/扩展/缺失记录）与 M0-T02（命令/事件/投影/outbox 控制面）。Runtime、沙盒、设备、构建、渠道与独立 Gate（T03–T08）尚未实现，M0 整体未通过；不能将规格要求视为已通过的能力。实测范围见 [M0 选型记录与能力矩阵](docs/m0/opencode-adoption.md)。

```text
git submodule update --init --depth 1 vendor/opencode
(cd vendor/opencode && bun install --frozen-lockfile)
bun script/setup.ts
bun script/bench.ts verify --suite contract-core --dataset contract-core/1
bun script/bench.ts verify --suite control-plane
```

| 目录 | 内容 |
| --- | --- |
| `vendor/opencode` | 锁定的 OpenCode 底座（submodule） |
| `packages/contracts` | GoalSpec、StageResult、Evidence、GateDecision 等合同 schema、交叉校验与固定样本 |
| `packages/delivery` | 基于 OpenCode `EventV2` 与 SQLite 的交付状态：命令回执、事件、投影、outbox |
| `script/bench.ts` | 评测入口，输出 result.json / events / artifact-manifest / metrics / human-interventions |

- [规格文档索引](docs/README.md)
- [OpenCode 选型决策](docs/decisions/0001-opencode-base.md)
- [交付状态存储决策](docs/decisions/0002-delivery-state-on-opencode-store.md)
- [M0 选型记录与能力矩阵](docs/m0/opencode-adoption.md)
- [产品、四层架构与 harness 边界](docs/loopit-workbench-spec.md)
- [执行与交付契约](docs/execution-contracts.md)
- [验收与评测](docs/acceptance-spec.md)
- [M0–M3 实施规格](docs/milestones/README.md)
- [参考资料与选型依据](docs/reference-and-selection.md)

首个闭环针对现有 Loopit 移动端的真实小功能；具体功能、设备、分发渠道与预算尚待冻结。浏览器、手机 App、桌面 App 共用同一底座；不并行拼装第二套 Agent 平台，也不以 Claude Agent SDK/Claude Code 核心作为必需依赖。

过往工程仅作为参考及工具扩展候选。文档中的本地参考路径用于记录来源，相关外部文件未随本仓库发布。
