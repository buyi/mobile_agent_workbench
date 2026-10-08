# Loopit 移动端工作台规格

本组规格用于建设一个由人设定目标和验收标准、由系统自主完成研发交付并持续改进的 Loopit 工作台。首个业务验收对象已确定为现有 Loopit 移动端中的一个真实小功能。

已确认采用 **OpenCode** 作为唯一开源主工程及 Agent 运行时，在其上补齐 Loopit 能力；取消双执行器和 Claude SDK 必接要求。具体发行版与能力实测由 M0 冻结，见[选型决策 ADR-0001](decisions/0001-opencode-base.md)。

| 文档 | 用途 |
| --- | --- |
| [产品与架构规格](loopit-workbench-spec.md) | 产品模型、四层架构、harness 边界、能力范围、建设顺序与待定决策 |
| [执行与交付契约](execution-contracts.md) | 六个研发环节的输入输出、状态、协议、证据、恢复和短路规则 |
| [验收与评测规格](acceptance-spec.md) | 首个真实功能闭环、稳定性与性能门槛、故障注入、自我迭代验收 |
| [参考资料与选型](reference-and-selection.md) | 过往建设的取舍、moremore 候选、官方资料与接入验证要求 |
| [OpenCode 选型决策](decisions/0001-opencode-base.md) | 已接受的唯一底座、复用边界、M0 待验证项与重新评估条件 |
| [交付状态存储决策](decisions/0002-delivery-state-on-opencode-store.md) | 交付事件、回执、outbox 落在 OpenCode 原生存储上的依据与缺口 |
| [M0 选型记录与能力矩阵](m0/opencode-adoption.md) | 锁定 BOM、沿用/扩展/缺失、实测能力矩阵与待冻结决策 |
| [M0 契约与接入验证](milestones/m0-contracts-and-integration.md) | 最小控制骨架、Runtime/设备/构建/渠道合同实验与 M1 输入冻结 |
| [M1 真实功能自主交付](milestones/m1-autonomous-feature.md) | Loopit 真实小功能六阶段闭环、自修复、恢复与内部交付 |
| [M2 日常工作台 v1](milestones/m2-daily-workbench.md) | 同一底座三端、自有后台、日常评测与最小经验晋升 |
| [M3 工作台自主迭代](milestones/m3-self-improvement.md) | 长期目标下的自主改进、独立评测、自身升级/回滚及学习接口 |

实施时从[分阶段总览](milestones/README.md)进入，按 M0 → M1 → M2 → M3 的交接合同推进。各阶段 spec 分别定义输入、需求、实现切片、可测验收及退出条件；共同状态和证据语义仍以执行契约为准。

状态：2026-10-08，v0.3 评审稿。MUST 表示必须满足，SHOULD 表示默认应满足，MAY 表示可选。文中的性能数字、预算及评测样本量均为拟定的工程验收目标，不表示已取得实测结果。规格本身不代表已授权对业务仓库、设备或生产环境执行发布操作。
