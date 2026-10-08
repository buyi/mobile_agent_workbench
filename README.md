# Loopit 移动端自主研发工作台

以 **OpenCode** 为唯一开源主工程和 Agent 运行时，为 Loopit 建设自主研发工作台。人设定目标与验收标准，系统完成需求、设计、开发、验证、内部交付和运维观察。

当前为 **v0.3 规格阶段**：OpenCode 选型已确认，具体发行版、扩展方式及能力实测由 M0 完成。本仓库当前仅包含规格与决策文档，尚未引入 OpenCode 源码或实现产品；不能将规格要求视为已通过的能力。

- [规格文档索引](docs/README.md)
- [OpenCode 选型决策](docs/decisions/0001-opencode-base.md)
- [产品、四层架构与 harness 边界](docs/loopit-workbench-spec.md)
- [执行与交付契约](docs/execution-contracts.md)
- [验收与评测](docs/acceptance-spec.md)
- [M0–M3 实施规格](docs/milestones/README.md)
- [参考资料与选型依据](docs/reference-and-selection.md)

首个闭环针对现有 Loopit 移动端的真实小功能；具体功能、设备、分发渠道与预算尚待冻结。浏览器、手机 App、桌面 App 共用同一底座；不并行拼装第二套 Agent 平台，也不以 Claude Agent SDK/Claude Code 核心作为必需依赖。

过往工程仅作为参考及工具扩展候选。文档中的本地参考路径用于记录来源，相关外部文件未随本仓库发布。
