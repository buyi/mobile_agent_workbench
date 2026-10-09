# OpenCode CLI 本地生命周期切片

这是 M0-F03/F04/F05 的局部实现。没有新建 Agent 推理循环，也没有修改 OpenCode。`delivery` 已通过 [WorkerDispatch](../delivery/src/integration/README.md) 接入本地生命周期；新增可信宿主的受限编辑配置入口；是否已真实接通由独立集成实验取证，本包测试不代表自主交付通过。

运行测试：`bun test packages/runtime/test`。合同代码直接从仓库内的 `packages/contracts/src` 引入，无需修改根工程配置或安装新的依赖。

## 已实现的接口

| 接口 | 当前语义 |
| --- | --- |
| `probe()` | 校验固定绝对可执行路径的 SHA-256，执行 `--pure --version` 和 `--pure run --help`。CLI 可用不代表模型编辑、工具或用量验证通过。 |
| `start(input, operationId)` | 校验 ExecutionSpec、ContextManifest 及输入摘要；先建立操作和工作区 reservation，再创建进程组，通过 stdin 发送唯一初始 prompt。重复同一 Attempt 和请求返回已有 handle。 |
| `prepareStart(input, operationId)` / `startPrepared(input, operationId, token)` | Delivery 使用的两步启动入口：异步完成有界 version/help 探测，再用绑定完整输入和 operationId 的单次 token 启动。token 仅由同一 Adapter 实例识别；不能伪造、跨实例、换输入或重复使用。最终启动仍重新核对二进制摘要。 |
| `observe(handle, cursor)` | 输出可按序号补读的本地 started / exited / failed 事件；OpenCode 原生输出保存在有大小上限的日志中。尚未归一化模型和工具事件。 |
| `cancel(handle, reason)` | 对本进程仍拥有的执行组先发 TERM，再发 KILL，分别核对退出状态与进程组状态。暂停使用 `reason="pause"`，当前 Attempt 记为 `interrupted_for_pause`。 |
| `inspect(handle)` | 区分父进程状态、进程组状态与调用者所有权。重新打开 Adapter 后，不根据旧 PID 猜测所有权或发送信号。 |
| `reconcile(handle)` | 返回 quarantine；缺少完整后代、设备和外部作业核对时，不自动解除 reservation。 |
| `collect(handle)` | 返回当前日志摘要、截断标记、输入/状态文件和摘要。它不等待管道关闭，也不返回业务通过。 |
| `dispose(handle)` | 请求停止，保留日志和 reservation，`cleaned=false`，等待独立 Supervisor 完成安全核对。 |
| `releaseStoppedReservation(handle, authorization)` | 可信宿主先核对独立停止证明，再精确归档一个已完整退出的纯代码 reservation；不恢复旧进程，不释放未知执行或外部动作。 |
| `sendInput()` / `checkpoint()` | 显式 unsupported。恢复通过 Delivery 的显式恢复命令创建新 Attempt。 |

## 环境与输入边界

每个 Attempt 使用独立 HOME、XDG_CONFIG/DATA/CACHE/STATE 和 TMPDIR。环境从显式白名单建立，不继承调用进程的模型密钥、代理、OpenCode 配置、NODE_OPTIONS 等变量。设置 `OPENCODE_DISABLE_PROJECT_CONFIG=1`、`OPENCODE_DISABLE_EXTERNAL_SKILLS=1`、`OPENCODE_DISABLE_CLAUDE_CODE=1`，并使用 `--pure` 禁用外部插件；`--pure` 本身不等于关闭外部技能扫描。

默认仅支持显式初始 prompt、指定模型和固定 `{"*":"deny"}` 工具权限。三者分别以 `digestOf(prompt)`、`digestOf(spec.model)` 和 `digestOf({"*":"deny"})` 绑定到 ContextManifest 的 instruction / model / permission 项。尚不接受工具、知识、历史、skills 或追加材料；默认不加载个人凭据。受限编辑必须显式启用下面的可信宿主配置。

可执行文件摘要在探测与启动前校验；可执行目录仍须由可信 controller 管理，防止校验后被替换。默认固定路径与环境隔离不构成 OS 沙盒，本包默认能力报告的 `sandboxKinds` 为空；受限模式禁止调用未隔离的同步 probe/start。

Delivery 在数据库写事务外调用异步 `prepareStart`，每项 CLI 探测最多 5 秒、输出最多 64 KiB；在短事务内重新检查任务仍可运行，再调用 `startPrepared`。慢探测期间，同进程及另一进程的暂停都能提交并抑制随后启动；外层事务尚未提交时禁止派发。最终事务仍包含哈希与本地文件 I/O，慢磁盘及生产负载下的尾延迟尚未验收。独立调用旧 `start()` 的同步 API 不自动获得此异步行为。


## 可信宿主受限编辑

`CliOptions.restricted` 提供固定 `readPaths/editPaths`、原生 agent 名称/steps、模型/variant、catalog 路径与摘要、access-only OAuth resolver，以及独立 runtimeDirectory、child UID/GID、受保护 launcher 和 Seatbelt denyRead/proxyPort。用户目标和模型输出不能改变这些宿主能力。`restrictedConfigDigest`/`restrictedConfigBinding` 仅摘要公开能力配置，不含 resolver 或秘密；Delivery 将其、精确权限和绝对预算绑定到 ContextManifest。

受限入口只允许 root controller 在 macOS 上使用 `prepareStart/startPrepared`。binary/catalog/wrapper 必须是 root-owned、不可 group/world 写、无 ACL 的已锁定文件；祖先也须 root-owned 且不可被替换（允许 root-owned sticky 临时目录）。控制 stateDirectory 为 root-owned 0700。子进程 runtimeDirectory 和预建的 home/config/data/cache/state/tmp 六子目录为目标 UID/GID、0700；候选目录为该 UID/GID，且不可 group/world 写。目录不允许互相包含、符号链接或复用控制状态。ACL 探测在事务外完成，最终授权再次核对身份、目录、固定文件摘要，但不执行同步 ACL 子进程；state 和可信文件不能交给 Worker 修改。

`isolation.admission:{scopeId,generation}` 由宿主显式提供并进入配置摘要；Runtime只从该字段构造 `LOOPIT_SCOPE_ID/LOOPIT_GENERATION`，不继承环境。wrapper 在固定 root-private Supervisor state 的共享 launch gate 内核对活动 scope/generation、阶段和 UID/GID，直到完整降权才释放；Supervisor先独占该门禁、持久撤销admission，随后才扫描/停止专用UID。Worker只允许running阶段，Signer只允许finalizing阶段；过期/旧generation及延迟到停止后的root launcher都拒绝执行。

固定 launcher 形状为 `/usr/bin/python3 <root-owned wrapper.py> --uid <uid> --gid <gid> --`，后接 Seatbelt 命令；wrapper 由宿主安装并负责清空继承组、降权及再次核对真实/有效 UID/GID/groups。准备阶段通过同一 launcher→Seatbelt 核对固定 Bun FFI 程序读取的 real/effective UID/GID 与传统 libSystem `getgroups` 内核组、OpenCode version/help 与 `debug config`，检查实际原生权限、模型、agent steps、插件、MCP、LSP/formatter 配置。实际 run 使用相同边界，任何探测失败均禁止裸跑。

精确 read/edit 路径是 OpenCode 原生权限；Seatbelt 的写入范围仍是候选工作区和子进程运行目录，不构成 OS 逐文件授权。候选差异、路径逃逸、最终内容与验收必须由独立 Verifier 检查。代理仅限制 localhost 代理端口，不宣称域名白名单。

OAuth resolver 仅允许 `{access, expiresAt, accountId?}`，有五秒超时、有效期检查，拒绝 refresh 等额外字段；实际 `OPENCODE_AUTH_CONTENT` 仅在内存环境传入，refresh 固定为空，不复制个人认证 store。含认证的输出先完整有界捕获再跨 chunk 脱敏；截断/未完整捕获则整段省略。`logs.redactionPending` 明示尚未落盘，原始输出和 access 不写 input/state/log。OpenCode 自身可能在专用 Worker runtimeDirectory 产生本机日志，该目录不属于 controller 证据，也不可用作可信回执。

受限输入必须有 `executionBudget:{deadlineAt,repairIndex,maxRepairs:3}`，不超过未来60分钟且最多三次 repair。运行计时取本次预算、绝对剩余时间和 access 有效期三者最小值，超限紧急停止。Delivery 持久绑定同一 GoalRevision 的首个 deadline，拒绝重开数据库后续 Attempt 续期及 repair index 换号。本地状态回滚/丢失仍需独立恢复日志，不宣称跨故障域计量已完成。

## 停止与恢复的实际保证

- Adapter 自身控制范围仅为 POSIX 进程组，因此 `processTreeControl=limited`、`cancelMode=limited`。已部署的外部 Supervisor 另行核对专用 UID420/421 全部进程及服务域，覆盖本机逃逸后代；这不证明设备或远端作业已停止，也不改变 Adapter 单独的能力声明。
- 父进程提前退出时，不把退出码当作完整进程树停止。后代若仍持有管道，100ms 后停止读取并标记截断；`collect` 始终返回当前有界文件，不等待后代关闭管道。
- spawn 前的必要状态、输入和日志文件写入必须成功，失败则禁止启动。spawn 后的状态/日志写入失败被捕获，返回 `observed.evidence.available=false` 和 `observed.persistenceErrors`（含 phase/message）；产物读取失败另返回 `artifact.available=false`。已知本地所有权且 handle 匹配时，紧急停止直接使用内存中的 PID 与执行状态，写盘失败或状态文件不可读不能阻止 TERM/KILL。未知恢复 PID 仍禁止信号。存储失败不会变成成功验收，reservation 继续保留。
- 停止回执始终保留 `safeToRedispatch=false`。每个未经独立安全核对释放的 reservation 都继续占用并发槽：即使父进程已退出、进程组已不存在、下一 Attempt 使用另一个工作区，也拒绝新派发。`releaseStoppedReservation` 要求精确原输入、操作、完整退出及管道记录，先持久化授权，再原子归档 reservation；同一授权重放不能释放后续 Attempt。停止证明的真实性由可信宿主核对，摘要字段本身不是 OS 证明，不能向 Worker 暴露此宿主接口。
- reservation 在 spawn 前以排他创建落地，同一 stateDirectory 下使用排他 admission lock 串行检查父/子工作区重叠和活动 Attempt。进程在记录 PID 前崩溃会留下无法确认的 reservation/lock，后续拒绝再次派发。stateDirectory 与工作区不能互相包含。这里没有独立恢复日志、跨主机 fencing 或整机断电持久性保证。
- 默认模式只限制当前 Attempt 的 wall-clock 时间；受限模式额外强制宿主冻结的绝对 deadline 和至多三个 repair index。同一持久 stateDirectory 最多允许一次新的派发，直到独立停止核对及 reservation 归档完成。重新打开 Adapter 仍保留这一约束；重复同一已记录请求可以取回旧 handle，不会再次启动。Delivery 已累计上层预算；供应商内部重试和无法观测的模型用量仍保留 unknown。

## 验证边界

测试中的可控可执行文件只验证生命周期协议，不模拟真实 AI 编辑成功。测试覆盖环境隔离、摘要/版本不匹配、命令去重、操作 ID 冲突、暂停与进程组停止、恢复后未知状态禁止复派、日志上限、父进程退出后后代保留管道。

设置 `LOOPIT_OPENCODE_BINARY` 为固定二进制的绝对路径时，另执行真实 `1.18.35` 的版本/帮助探测；未设置时明确 skip，不计为真实 Runtime 通过。已设置但路径不存在或版本错误时测试失败。可通过 `LOOPIT_OPENCODE_EXECUTABLE_DIGEST=sha256:<hex>` 提供预期摘要；未提供时从该本地文件计算摘要，只验证本地一致性，不代表发行来源已校验。正式交付应从可信发行清单固定来源和摘要。

`promptAcknowledged`、`settled` 和 usage 在本适配器的通用 collect 结果中保持 unverified；进程退出与 GateDecision 分开，`gate=not_evaluated`。本包测试不调用付费模型。2026-10-09，独立部署的 [控制主链路](../../docs/m0/control-loop.md)已通过此 Adapter 调用真实 OpenCode 修改固定代码，并将原生步骤用量、UID421 验证签发、Gate 和 Delivery 接通；[控制矩阵](../../docs/m0/control-matrix.md)另以无模型 fixture 通过暂停、冷读、恢复和取消。两者均不代表 Loopit 业务功能或完整 M0 验收。

macOS 上新版 SDK 的 Python `os.getgroups()` 和 `id -G` 可返回目录服务成员列表，不随 `setgroups()` 改变，不能拿它们证明继承组已清空。wrapper、Supervisor reaper 显式调用传统 libc `getgroups` 符号，受限 Runtime 使用已锁定的 `isolation.identityRuntime:{path,digest}` Bun 通过 FFI 读取同一符号，严格要求内核组只有目标 GID；目录组仅作诊断，不作为额外组放行条件。[Python 官方说明](https://docs.python.org/3/library/os.html#os.getgroups)。

Worker 内部身份探测不启动 `/usr/bin/python3`：macOS 的该路径可能通过 xcrun/xcodebuild shim 初始化开发工具，增加隐式子进程和启动延迟。identityRuntime 与 binary/catalog/wrapper 一样验证 root-owned 路径及摘要，并进入公开配置摘要；探测和真实 OpenCode 都经过相同 wrapper→Seatbelt。普通 UID 的 FFI 单测只证明脚本读出当前身份，专用 UID/Seatbelt 的真实通过仍需独立部署取证。
