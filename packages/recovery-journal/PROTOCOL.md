# Recovery journal 本地协议切片

本包实现单个权威 SQLite journal 与单请求 CLI，尚未部署另一台主机。`localStdioTransport` 每次调用独立 Bun 进程，但数据库仍在当前机器；这些测试不证明独立故障域，也不满足 M0-A11。

每个连接设置并核对 `synchronous=FULL`，使用 WAL、5 秒 SQLite busy timeout，并启用 `fullfsync` / `checkpoint_fullfsync`。所有变更使用同步 `BEGIN IMMEDIATE` 事务；只有 COMMIT 返回后才产生成功响应。尚未做断电、磁盘故障或跨机器恢复实验，存储设备实际耐久性不能由这些设置替代证明。

## 调用方式

由可信管理员先准备专用、不可由 Worker 写入的目录，再执行一次：

```sh
bun script/m0/recovery-journal.ts init --db /absolute/dedicated/journal.db
```

返回随机 `journalId`。该 ID 应由操作者独立分发和固定；已有数据库不会被重新初始化或覆盖。数据库文件以 0600 创建。管理员命令为：

```sh
bun script/m0/recovery-journal.ts admin --db /absolute/dedicated/journal.db --journal-id <pinned-id>
```

stdin 的一条 JSON 示例（最后关闭 stdin）：

```json
{"schemaVersion":"recovery-journal-request/1","requestId":"admin-1","journalId":"<pinned-id>","method":"initializeScope","scopeId":"channel-1","fence":{"ownerId":"worker-1","generation":1,"epoch":1}}
```

切换 owner 或恢复授权使用 `advanceFence`，传 `scopeId`、`expectedFence` 和 `nextOwnerId`。服务在事务中比较完整旧 fence，再把 epoch 与 generation 各加一。旧 fence、并发失利的管理员请求和重复初始化均拒绝。

业务请求命令为：

```sh
bun script/m0/recovery-journal.ts request --db /absolute/dedicated/journal.db --journal-id <pinned-id> --owner-id <authenticated-owner>
```

请求共有 `schemaVersion`、`requestId`、`journalId` 字段；`currentAuthority` 携带 `scopeId`，`reserveDispatch` 携带 Delivery 的完整 `DispatchIntent`。只接受支持的 schema 和字段，stdin 上限 1 MiB、读取截止 5 秒。stdout 只有一条 JSON；成功退出 0，拒绝/不确定退出 2。`localStdioTransport` 默认 10 秒截止且不自动重试。本包另提供下述系统 OpenSSH 适配，不包含凭据发现、监听器或自动部署；原本地协议和 CLI 保持兼容。

`request` 模式拒绝管理员方法；`owner-id` 必须由可信传输绑定，不能来自模型或请求体。**CLI 参数不是认证机制。** 上线时必须由管理员/Worker 不同系统身份、数据库文件权限及受限传输命令建立访问边界，防止 Worker 改变 owner 参数、调用 admin 或直接修改数据库。本地同用户调用仅用于协议验证。

## 受限 SSH stdio 适配：尚无远端部署证据

`sshStdioTransport(config)` 可注入现有 `createRecoveryJournal({ journalId, transport })`。配置由可信宿主在模型/工具请求之外冻结，结构为 `SshStdioConfig`（`src/ssh.ts`）：

| 配置 | 宿主负责的内容 |
|---|---|
| `schemaVersion` | 固定为 `recovery-journal-ssh/1` |
| `host / user / port` | 明确的 DNS/IPv4 主机名、SSH 系统用户名及端口；当前不支持 IPv6、跳板或 SSH alias |
| `journalId / ownerId` | 操作者独立固定的 journal 与该 SSH 身份获授权的业务 owner |
| `knownHosts: {path,digest}` | 已带外核验 host key 的专用公开文件及字节 SHA-256；不自动接受或更新 host key |
| `identity: {path,publicFingerprint}` | 宿主明确提供的受控私钥路径；公开 fingerprint 仅为描述，不代替认证或验证实际密钥 |
| `forcedCommand` | `selector` 固定 `loopit-recovery-journal-request-v1`；`deploymentRef: {ref,digest}` 记录管理员 forced-command 配置的未来部署前提 |
| `timeoutMs` | 可选，默认10000、上限30000；覆盖SSH启动后的stdin/stdout/stderr/exit等待，只执行一次，不重试 |

适配器不读取、复制、打印或计算私钥摘要，只检查其路径与文件属性；实际认证时由系统 `/usr/bin/ssh` 读取该显式身份文件。公开 known_hosts 做有界摘要核对。两类引用要求绝对规范路径、非符号链接/硬链接、受保护祖先和权限；macOS 的额外 ACL 无法确认为安全时直接拒绝。密钥文件禁止 group/other 权限。路径不接受空格、`%`、`$`、`~` 等 OpenSSH 展开语法。调用前后检查引用身份，宿主仍必须让 Worker 无法写入这些路径、配置及 transport 代码。

`publicFingerprint` 未从私钥导出或与实际公钥核验，不能报告为认证已建立。同步路径/摘要/ACL检查在SSH I/O计时窗口之外，ACL每条只读 `ls` 自身上限1秒；`timeoutMs` **不是包含这些检查的全请求绝对deadline**。可信宿主仍需外层绝对预算/停止机制，不能用本选项宣称全请求严格10秒内完成。

客户端用参数数组启动固定系统 SSH，`-F none` 禁读个人和系统 SSH 配置；关闭 agent、密码交互、代理、连接复用、转发和 TTY。仅公钥认证，`BatchMode=yes`、`StrictHostKeyChecking=yes`、`ConnectionAttempts=1`。环境只含固定 PATH/LANG 与禁 askpass 标记。远端 command 只有一个无参数固定 selector，不拼接请求、路径、owner 或 shell 文本；业务请求只通过 stdin JSON 发送。配置与请求的额外字段、管理员 method、journal/owner 不匹配均在启动前拒绝。

显式传 `CertificateFile=none`，本机系统SSH的 `-G` 结果确认唯一 `certificatefile none` 与唯一指定 `identityfile`。本机 `ssh_config(5)` 说明自动查找 `<identity>-cert.pub` 的条件是未显式指定证书；上述设置用于关闭该隐式候选。这次只验证了配置解析，未进行SSH握手或远端认证，不能据此声称远端只接受指定key、证书旁路负例或forced command已实测。真实部署仍须验证这些边界。

**最小远端认证前提尚未部署或验证**：管理员必须把此 SSH 公钥/系统账户映射到 root 管理且业务用户不可修改的 forced command，校验 `SSH_ORIGINAL_COMMAND` 恰为上述 selector（绝不 eval），清空不受信环境，再以固定 runtime/CLI/db/journal/owner 参数执行现有 `request` 模式。远端不得提供 shell、admin 入口、转发、用户 rc/环境或其他凭据绕过；管理员 fence/init 走独立管理身份。业务进程只获该 journal 所需权限，Worker 不能修改数据库或 forced command。`deploymentRef` 是宿主提供的前提引用，**并不证明配置真实存在、权限已建立或外部故障域独立**；客户端填写 owner 参数和公开 fingerprint 也不构成认证。

stdout上限128 KiB，stderr只做16 KiB计数并丢弃内容；超时、截断/无效JSON、输出过大、任何非零退出或signal、返回错误、request/journal/intent/ref/fence不匹配均不交付许可。即使 stdout 已有合法ACK，后续非零退出也保持不确定。还会经过现有 RecoveryJournal 端口的完整绑定验证。超时只终止本地SSH进程，不能推断远端未COMMIT，禁止自动重试或凭失败重新预约。

离线测试将 SSH 启动点替换成真实本机 fixture 子进程，另用系统 `ssh -G -F none` 仅解析固定选项；不连接网络、不启动sshd、不读取个人SSH配置、未使用真实私钥。这只证明客户端接线/失败关闭，不证明远端 host key、强制命令、凭据权限、存储耐久性或独立故障域；**M0-A11仍未满足**。未来资源提供后必须实际验证远端身份/权限、ACK丢失、旧业务快照、旧token及journal恢复策略，才能注册相应能力。

## 派发与恢复语义

- 事务原子核对当前 fence 和已绑定 owner；`scopeId + idempotencyKey` 永久绑定 operationId/requestDigest，operationId 和 dispatchId 另外全局唯一。
- 所有重复派发都拒绝，包括完全相同的 dispatchId；改 operationId、改摘要、恢复旧业务数据库、推进 epoch 都不能清空预约。没有删除、取消预约或自动重试接口。
- JournalAck 包含完整 intent；`durable.digest` 为其 canonical JSON 的 SHA-256，SQLite 保存相同 canonical JSON。客户端检查 requestId、journalId、intent、引用及摘要绑定。
- 进程退出或响应丢失意味着结果未知；先核对，不能以重新请求 journal 取得第二个许可。服务不查询真实渠道，因此没有把 journal 记录当作业务成功回执的接口。
- `journalId` 检测误接不同初始化的数据库。**复制或回滚 journal 自身会保留 ID**，不能据此发现副本或证明远端权威性。不得把 journal 与业务 SQLite 一起回滚；其备份恢复、旧主机停用和凭据撤销仍需外部部署流程和实验。

运行 `bun test packages/recovery-journal/test` 可验证本地重启、五进程竞争、提交后回执前 SIGKILL、旧业务状态重放和 fence 推进；不操作真实设备或发布渠道。
