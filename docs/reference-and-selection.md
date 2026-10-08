# Loopit 工作台参考资料与技术选型

日期：2026-10-08。本文区分本地文档声明、历史实验记录、官方公开能力与本项目建议。组件只有通过本项目的运行合同和目标环境实测后，才能获得对应能力标签；历史记录不能当作本项目的新实测结果。

## 0 当前决策：单一开源底座

2026-10-08 用户确认采用 **OpenCode**，使用一个现成开源工程作为主底座。本节及[ADR-0001](decisions/0001-opencode-base.md)替代 v0.1 的“自建控制层 + 多 Agent Runtime”组合提案。

- 一个主工程及其 Agent 运行时，优先通过插件、配置或可维护的派生修改扩展；保留上游的会话、工具、上下文、客户端、存储和运行循环。四层框架用于映射职责，不要求另外搭建一个通用平台。
- M0–M3 不要求第二 Runtime、跨 Runtime 切换或 Claude SDK 接入。“覆盖 Codex/Claude 日常场景”是能力覆盖，不是产品依赖要求。
- 核心执行路径必须能在相应开源许可下审计、修改和维护，不以专有 Agent 二进制为必需前提。模型 API、操作系统与移动构建工具的授权分别登记；不因此推断用户要求所有模型权重或系统工具开源。
- 标准依赖、数据库、设备驱动和 Loopit 工具插件可以使用；不得用“依赖”名义再拼接第二套完整 Agent 平台。所选底座有缺口时，先评估其扩展机制及最小改造，达不到硬要求就淘汰候选。
- 撤回 PostgreSQL、Temporal、Electron、React Native 等先于底座的默认选型。保留数据耐久、停止、恢复、证据、隔离及三入口验收要求，实施技术随底座确定。

**已选定 OpenCode，作为唯一主工程及 Agent 运行时，优先在其现有应用、服务和扩展机制上建设。** 选型由用户确认，具体发行版由 M0 锁定；这不代表 M0 已通过。本轮只有文档核查，没有完成构建、源码依赖审计、故障与性能横评。选择依据是完整开源 Agent 工程、已有 Web/桌面入口与服务接口，预期可减少重新搭建产品基础的工作；尚不能据此声称稳定性或性能优于其他工程。

OpenCode 的手机 App 路线、完整自主交付、可靠恢复、独立验收和发布能力仍需核实与补齐。手机网页不计作手机 App 已完成；插件接口存在也不表示所有交付约束都能仅靠插件实现。M0 若发现必须重写 Agent 核心或另搭一套完整平台才能满足硬要求，应依 ADR-0001 记录失败证据与重新评估决定，不静默切换或持续拼装扩大范围。

| 工程 | 当前处理 | 能力边界与后续要求 |
| --- | --- | --- |
| OpenCode | 已选唯一底座；[根许可为 MIT](https://github.com/anomalyco/opencode/blob/dev/LICENSE)，[官方服务端文档](https://opencode.ai/docs/server/)提供客户端接入边界 | M0 验证目标版本完整依赖、手机 App 缺口、无人交付扩展、停止/恢复与资源开销；根许可不代表所有依赖自动通过 |
| DeepSeek Harness | 仅保留参考；现有 Loopit 插件可评估移植工具能力，不引入完整 DSH 运行时 | [官方仓库](https://github.com/deepseek-ai/deepseek-harness)仍标 developer preview 和破坏性变更；旧插件依赖须在迁移时明确 |
| T3 Code | 保留三端和连接设计参考；暂不当作独立完整 Agent 底座 | 本地 README 明确依赖外部 Agent；不能仅凭控制面完整就声称满足单一运行时工程要求 |
| Codex、Pi 等 | 保留资料和历史比较记录，不作为并行接入清单 | Pi 同样具有完整 Agent、SDK/RPC 及持久化相关能力；本次优先沿用 OpenCode 产品入口，不推断其他项目质量更差 |

M0 输出一份 OpenCode“沿用 / 扩展 / 缺失”记录，包含固定源码版本、可构建证据、许可与运行依赖、必需新增代码、升级成本、故障实验和实测指标。M0 的第一项技术工作是锁定版本并核实合同映射；后续不得回退到多平台拼装来掩盖底座缺口。

OpenCode 自身的权限交互不提供安全隔离；OS 沙盒及资源边界仍需单独落实。[官方安全说明](https://github.com/anomalyco/opencode/blob/dev/SECURITY.md)

### Claude 许可边界

“SDK 有公开仓库”“可商业接入”“核心开源”是不同结论。[TypeScript SDK LICENSE](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md)不是 MIT/Apache 开源许可；[Python SDK](https://github.com/anthropics/claude-agent-sdk-python)包装层采用 MIT，但依赖 Claude Code CLI，不能据此把整套执行核心视为开源。官方确有[集成与使用条款](https://code.claude.com/docs/en/legal-and-compliance)，因此不能说闭源就一律禁止使用；但它不满足本项目要求的开源核心控制权，已从必需方案中移除。认证规则按产品集成方式另核查，不沿用“所有 SDK 个人使用都被禁止”的概括。

## 1 过往建设的取舍

以下本地来源仅作研究记录，未随本仓库发布；路径文本不能在 GitHub 上直接打开。本文已归纳设计取舍，阅读和实施本仓库规格不要求读者拥有这些本地路径。

| 资料 | 可借鉴内容 | 本次调整 |
| --- | --- | --- |
| 开源交付架构（本地来源：`/Users/buyi/Documents/ChatGPT/内功/docs/open-source-delivery-architecture.md`） | Task/Run/Artifact/Decision、公开 Runtime 边界、证据绑定、停止核对 | 不继承“保留 Electron 与既有交付核心”决定；三入口和常驻执行保留；日常能力由唯一底座覆盖 |
| 工作流蓝图（本地来源：`/Users/buyi/buyisure/workflow/docs/工作流建设-蓝图.md`） | 人只留在目标层、确定性约束、经验评测、改进循环 | 七层映射为本次四层；不强制十个角色、Linear、单一 DSH 内核或每次合并人工批准 |
| MVP 定义（本地来源：`/Users/buyi/buyisure/workflow/docs/mvp.md`）与验收标准（本地来源：`/Users/buyi/buyisure/workflow/docs/验收标准.md`） | 分清纯代码回路与设备交付，度量人工触碰 | 纯代码只作为 M0 接入实验；用户已要求 M1 真实 Loopit 功能，不能以壳跑通代替 |
| HELLO-1 复盘（本地来源：`/Users/buyi/buyisure/workflow/docs/postmortem/2026-09-10-HELLO-1-judge-bug.md`） | 验收器会写错、配置会泄漏、全量日志撑大上下文 | 验收器正反例、受控配置 manifest、增量审查及证据按需加载纳入首期 |
| 生长式应用理念（本地来源：`/Users/buyi/buyisure/workflow/docs/理念-生长式应用.md`） | 目标固定、实现方法可生成、经验可稳定复用 | 本次建设研发工作台；端侧运行时生成 App 逻辑是另一产品方向，不自动混入范围 |
| Mobile UI Runtime（本地来源：`/Users/buyi/yongyue/mobile-ui-runtime/README.md`） | 语义树、revision guard、操作后观察、身份与隐私处理 | 通过 Adapter 候选复用；当前插件形态和具体 DSH 依赖不是新工作台的公共协议 |
| 验证执行合同（本地来源：`/Users/buyi/yongyue/mobile-ui-runtime/docs/verification-execution-contract.md`） | 共享设备事务、截图新鲜度、重启日志边界 | 当前租约不覆盖外部 CLI/Panels；新工作台必须统一 Broker 或明确无独占能力 |
| Mobile UI Case（本地来源：`/Users/buyi/yongyue/mobile-ui-case/README.md`） | 产品 case、fixture、begin/finalize、oracle 与 release gate | 业务语义留在 Case Pack；版本绑定后接入工作台 Gate，不把脚本输出直接当整个 Task 完成 |
| Panels 性能说明（本地来源：`/Users/buyi/yongyue/loopit-panels/PROFILE.md`） | 设备/环境明确、证据时间窗、性能基线对比 | 参考观察体验及采集能力；React render 耗时与原生帧耗时保持区分 |

历史架构文档记录 Codex 隔离实验和模拟器验证进展，也记录业务闭环尚未贯通的限制。本规格不将这些记录重新表述为“工作台已经能自主交付”。

## 2 moremore 本地候选快照

以下 SHA 是本次只读检查所得的本地 HEAD 缩写，用于可追溯地说明参考点，不表示已采用发行版本。未修改、更新或运行这些仓库。根 README 的许可或能力声明不能代替拟抽取组件的完整依赖和发行验收。

| 项目与本地 HEAD | 借鉴或复用位置 | 提案 |
| --- | --- | --- |
| Codex `c248f6d48b97` | 完整 Agent 进程、App Server、原生工具和会话 | v0.1 首个 Runtime 提案已撤回；仅保留历史比较与协议参考 |
| Pi `cb7969d21283` | SDK/RPC、多 Provider、完整 Agent loop | 历史比较与协议参考，不在已选工程外再接一套运行时 |
| T3 Code `d2c9281b8112` | 三端交互、连接、环境所有权、事件与 Provider 边界 | 设计参考；依赖外部 Agent 的事实纳入单底座筛选，不默认抽取后另建控制面 |
| DeepSeek Harness `4878cdabd87d` | 完整运行时、工具插件、现有设备插件接入 | 历史比较与工具迁移参考，不纳入并行运行时；SDK 限制保留为研究记录 |
| OpenCode `7945de208964` | 多模型 Agent、客户端/服务边界 | 工程已选定；该 SHA 仅是参考快照，实际采用版本仍由 M0 核实锁定 |
| Goose `a701bb1756f0` | Agent、桌面/CLI/API 与工具扩展 | 保留历史比较，不作为附加 Agent 接入 |
| OpenHands `94e156a8c7b7` | Agent Canvas 与多后端控制体验 | 局部评估；本地 README 标为 beta，不能借历史项目声誉推断本代可靠性 |
| CodexMonitor `dd61b9abd37d` | Codex 会话、worktree、远程 daemon 交互 | 参考差异与会话交互，不默认引入另一套 Tauri 后端 |
| ZCode `29628c9acdb8` | Desktop/Web/CLI、共享 UI 与服务边界 | 先验证依赖与自托管边界，再考虑抽取；首期不整套搬入 |

本地直接阅读点：T3 架构（本地来源：`/Users/buyi/yongyue/moremore/t3code/docs/internals/overview.md`）、Pi RPC（本地来源：`/Users/buyi/yongyue/moremore/pi/packages/coding-agent/docs/rpc.md`）、DSH SDK（本地来源：`/Users/buyi/yongyue/moremore/deepseek-harness/packages/sdk/client/README.md`）、Codex App Server（本地来源：`/Users/buyi/yongyue/moremore/codex/codex-rs/app-server/README.md`）。其余候选以根 README 和用户提供的既往研究作为本轮初筛依据，不据此声称完成源码审核。

### 2.1 影响设计的已知差异

- T3 本地架构文档明确执行状态属于拥有工作区的环境，客户端只通过认证 RPC 控制；持久事件、投影和命令回执共同提交。这些边界可借鉴，内部包是否适合独立使用仍需 spike。
- Pi 本地 RPC 文档将命令接受、agent_end 与 agent_settled 区分；不能收到 prompt ACK 就把任务结束。其根 README 明确不自带文件、进程、网络、凭据的权限系统，需要外部隔离。[Pi 官方仓库](https://github.com/earendil-works/pi)
- DSH 本地 SDK 文档说明高层结果是 receipt-to-idle 区间的最后已提交回复，不能总是归因到单个 prompt；当前缺少 mid-turn cancel 和完整双向审批请求。停止整个进程与中止一轮不同，必须按目标版本验证。
- Codex 本地 App Server 文档对实验性的 `userVerification/cancel` 明确区分取消信号 ACK 与原系统操作结束；这项证据只支持该接口的语义。整个 Agent 的停止、进程树和外部副作用仍须用锁定发行版单独验证，不从该接口推定，不依赖实验字段作为首期必需能力。

### 2.2 复用决策顺序

以已选定的 OpenCode 为主工程，优先利用它的配置与扩展点，必要时维护范围明确的 fork。独立驱动或工具包用于补缺，不拆多套 Agent 核心拼装。每项依赖记录来源、固定版本、组件许可、NOTICE、传递依赖、升级策略和回退版本。

实际采用前必须检查目标操作、停止/恢复、资源开销、许可边界和升级兼容。优先扩展主工程现有状态与持久机制，保持一个权威交付模型；不能因为上游已有 Task 数据库就预先放弃整体复用、改为自建。维护活跃和 Star 不作为功能验收证据。

## 3 补充的官方能力依据

| 来源 | 核验结论与本项目取舍 |
| --- | --- |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | 官方提供工具与 Agent loop 的集成能力；公开接口不等于执行核心开源，已从本项目必需依赖移除，详见第 0 节 |
| [T3 Code](https://github.com/pingdotgg/t3code) | 官方 README 声明 Web、iOS/Android、Electron 入口，同时标注项目处于早期；适合参考多入口控制，不据此承诺稳定性 |
| [Temporal Workflow Execution](https://docs.temporal.io/workflow-execution) | 持久历史与 replay 支持恢复，工作流代码需满足确定性要求；非确定性的模型调用放在外部执行 Activity |
| [Temporal Activity Definition](https://docs.temporal.io/activity-definition) | Activity 可多次执行或部分执行，外部成功但回执丢失会引发重试；幂等必须由外部服务/代理落实 |
| [Hermes Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) | 有容量边界的持久记忆、会话历史与检索可支持经验连续性；写入、持久化和对后续会话可见是不同状态 |
| [Hermes Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) | Agent 可创建、修改和使用技能，复杂方法可按需加载；这种程序经验改进不等同在线训练基础模型权重 |
| [Playwright Emulation](https://playwright.dev/docs/emulation) | 浏览器手机模拟改变 viewport、UA、触控等；适合验证工作台 Web，不能证明原生 App 或真实手机 OS 行为 |
| [Playwright Android](https://playwright.dev/docs/api/class-android) | Android 能力标为 experimental，覆盖 Chrome/WebView 等；不作为默认的完整移动端验证底座 |
| [Maestro 平台支持](https://docs.maestro.dev/get-started/supported-platform) | 可评估 Android 真机/模拟器与 iOS 模拟器回归；该页面未承诺 iOS 真机能力，不将其写为已覆盖 |
| [Appium XCUITest](https://appium.github.io/appium-xcuitest-driver/latest/overview/) | 支持 iOS/iPadOS 模拟器及真机、原生和混合应用；设备签名、生命周期与隔离仍由宿主管理 |

以上是能力与语义参考，不是安装清单。Agent 循环使用唯一底座已有实现；Temporal 只保留持久执行语义参考；设备工具作为底座的工具扩展。任何接入仍需端到端验收。

## 4 M0 选型实验与淘汰条件

| 实验 | 需交付证据 | 不通过时的处置 |
| --- | --- | --- |
| 唯一底座与 Runtime 合同 | 整体可构建、许可与核心依赖、一次编辑及验证、事件、取消、进程树清理、恢复、成本来源 | 淘汰或替换整个候选；不能叠第二套 Agent 来绕过缺口 |
| 整体复用与扩展 | 原生会话/工具/控制面的沿用清单，三端缺口、插件或 fork 修改范围、升级与性能成本 | 比较另一个完整候选；不得先假定重建通用控制层更便宜 |
| 持久调度 | 在底座原生机制上测试重启、重复派发、外部成功回执丢失与历史升级 | 记录最小扩展或淘汰；不默认引入第二调度平台，不削弱恢复合同 |
| 移动工具 | 目标 Loopit 包上运行 conformance、安装身份、UI、日志、网络、取消和资源恢复 | 逐能力替换 Provider；iOS/Android 分别记结果 |
| 内部分发 | 相同操作重复提交、回执查询、安装验证、停止分发和可用回滚策略 | 缺乏可核对副作用的渠道不用于自动重试发布 |
| 经验学习 | 禁用/启用经验的对照、反例、撤回、跨项目隔离 | 无可复现收益就保留记录，不启用自动晋升 |

M0 输出一份锁定的 Bill of Materials 与 capability matrix，记录“支持、受限、不支持、未验证”；仅 supported 且已实测的能力可用于无人交付承诺。后续升级重复相关合同评测，不按最新版本号自动升级执行环境。
