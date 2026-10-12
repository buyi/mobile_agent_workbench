# M1 诊断信息页输入草案

用户已经确认功能、首验平台、本机交付终点、Loopit 基线与模型。本目录保存这些确认及本机可核验材料，避免再次询问同样的问题。**它仍是准备草案，不能启动正式 M1 Run，也不是 M0-A15 通过记录。**

| 文件 | 用途 |
| --- | --- |
| [confirmed-inputs.json](confirmed-inputs.json) | 区分用户确认、技术实测、执行方法提案与尚未冻结条件；原话未导出，内容明确标为会话确认摘要 |
| [goal.draft.json](goal.draft.json) | 按现有 `goal/1` 字段整理的部分 GoalSpec；刻意缺少尚未冻结的必填字段 |
| [materials.json](materials.json) | 本机文件/基线包的实际路径、摘要与固定引用；不是设备或资源 Broker 注册表 |
| [implementation-scope.json](implementation-scope.json) | 固定基线的设置入口、诊断页路径、现有能力复用与最小修改范围；尚非执行策略 |
| [cost-policy.json](cost-policy.json) / [large-text-rubric.json](large-text-rubric.json) | 单独确认的 M1 费用策略与最大辅助功能字号验收映射；尚未部署到受保护验证器 |
| [execution-policy.draft.json](execution-policy.draft.json) | 版本 1 执行边界：限定写入、角色权限、敏感信息、总预算、停止与清理；包含 `policy/1` 已确定字段，缺失字段明确列出，尚未发布 PolicyRef |
| [diagnostics-fixtures.json](diagnostics-fixtures.json) | 6 组合成元数据/敏感字段反例；来源是现有公开版本信息模块，无真实账号、token 或登录数据 |
| [diagnostics-case-pack.json](diagnostics-case-pack.json) | 4 组验收步骤、独立正反例、证据绑定与六阶段输入/输出；复用已有大字体 rubric，所有用例均尚未执行 |
| [ios-local-podspec-checksums.patch](ios-local-podspec-checksums.patch) | 已记录的两行 Podfile.lock 校验和修复副本，无 M1 业务代码 |
| [readiness.json](readiness.json) | 使用现有合同解析器和本机字节核验生成的准备报告，状态保持 `blocked` |

已确认的功能标准保持原意：显示并复制版本、build、环境；不包含账号或 token；支持返回。用户另于 2026-10-09 确认在系统最大辅助功能字号下验收，安装后观察 30 分钟并完成 10 次完整操作。每次操作读取一次存活/前台状态，映射为 10 次健康观察；没有另加独立性能阈值。专用 iPhone 17 Pro / iOS 26.0 是现有实验设备材料，尚未具备生产 Broker 所需的 OS 独占能力。

M0 的 **60 分钟、最多 3 次修复、允许美元费用 unknown** 仅为已结束的 M0 实验授权。用户已单独确认 M1 **120 分钟、最多 3 次修复**，继续使用 `openai/gpt-6.1-sol` 套餐，费用记 unknown；本目录使用独立 M1 `costBudgetRef`，不延长 M0 截止时间。M1 仍须等 M0 Gate 和资源/策略冻结通过才能启动；未复制 token 或凭据内容。

策略和 Case Pack 已有具体准备版本，仍缺工程负责的受保护发布：固定 Runtime/工具与网络出口、worker/凭据句柄、保留和清理预算策略、设备 Broker、本机渠道与环境执行器、独立验证身份和测试 Runner。RecoveryJournal 的本机 SQLite 和离线 SSH 测试尚不证明独立故障域与远端认证；M0 总体能力证明仍阻断 M1。日常技术选择不要求用户逐文件操控。

`goal.draft.json` 的预算、费用、大字体 rubric 和本地 fixture/Case Pack 都有真实摘要引用；`policyRef` 与设备注册仍缺失。策略的 `policyDraft` 刻意不填未确定的网络模式、工具/资源引用、保留策略与最终摘要，现有解析器应拒绝将两者作为完整执行合同。没有用假的空资源或 dummy digest 凑成可解析策略。21 项本机材料与 13 份范围源码都有真实摘要；现有 `.app` 是基线加记录补丁的产物，尚不含诊断信息页。

这三份新材料均为 `prepared-not-protected`，Goal 中的 fixture 引用只证明内容身份，不能证明 Builder 无权修改它们。Case Pack 将已确认的五条标准映射为显示、复制与隐私、返回、最大字号四组测试；30 分钟/10 次完整路径另外记录在观察部分。复制文案与序列化格式留给 DesignSpec，未新增像素、性能、文案或测试频率标准。未来的独立 Runner 需要根据冻结设计形成自己的比较器，不可使用候选自带的“通过”结果。

当前没有可证明的无真实账号页面 fixture 或独立设备 clipboard，因此不假设能直接进入设置页，更不通过登录真实账号、绕过认证或读取操作者剪贴板来补洞。模拟器初始安装、字号、clipboard 和电源状态必须由 Broker 记录；清理只涉及本 Run 拥有的资源。恢复或卸载无法确认时隔离资源，不能以清理成功覆盖之前的验收失败。

实现范围已对照冻结基线定位：从 `app/settings.tsx` 增加入口，`app/diagnostics.tsx` 仅接页面 public API，页面归 `src/pages/diagnostics`。这里采用仓库已接受的 pages-first 合同；旧个人 skill 的 feature-first 目录建议不覆盖该基线。版本、build、环境直接复用 `src/shared/application`，复制复用已有 `expo-clipboard`。保留原设置页与认证逻辑，只增加所需文案和精确架构登记，不迁移整个设置模块。范围文件固定了 13 份源码/合同摘要；架构配置只允许追加本页的精确登记，独立验证必须拒绝修改旧规则或放宽门禁。此次没有改动 RN 源码。

旧 preflight 的 Podfile.lock 摘要 `bdfb928…` 对应未修复基线；当前两行修复后的锁文件为 `82b23dee…`。原报告字节已保存在 `ios-preflight-before-lock-metadata-correction.json`；纠正后的 `ios-preflight.json` 分开记录 base/prepared 摘要，并明确此次是构建后的只读核对，没有重跑构建，也不伪称原构建时已经捕获这些字段。材料索引同时固定新旧报告。

在仓库根目录进行只读复核：

```sh
bun script/m0/validate-m1-inputs.ts
```

退出码 `2` 表示材料一致但 M1 仍被未冻结条件阻断；`1` 表示材料缺失、身份变化或绑定不一致。检查包含 Case Pack 的标准、路径、预算、引用、正反例与六阶段 IO 一致性；无论通过多少本地检查，`deliveryRunAllowed` 都保持 `false`。命令读取文件、Git 状态及 `.app` 字节清单，不启动模拟器、调用模型、写业务源码或发放 Gate。需要更新报告时可将 stdout 保存为 `readiness.json`，不得因脚本退出非零就丢弃报告。

所有 `file://…#sha256:…` 引用均指向本机真实材料。目录摘要采用既有 `ios-app-inventory/1` 算法，文件使用字节 SHA-256；它们不是新建的通用解析协议。移动机器或删除 `.bench` 后必须重新解析材料，不能只凭文档中的路径宣称资源仍可用。已有安装、UI 和清理报告仅保留原来的能力实验结论，不升级为正式回执。
