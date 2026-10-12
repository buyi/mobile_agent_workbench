# M0 确定性验证与签发

本包只验证已授权的 `sumEvenThrough` 代码实验：原有 8 组结果与 4 组 RangeError 用例。它不验收 M1 诊断页、不代表 M0 里程碑通过，也不是通用测试托管服务。

入口是 [`script/m0/verify-candidate.ts`](../../script/m0/verify-candidate.ts)。生产入口固定 UID **421** 和配置路径 **`/private/var/loopit/signer/m0-verifier/config.json`**，不接受命令行参数或环境变量覆盖。由受信任的控制器按已授权身份运行 signer 父进程；父进程需要读取签名密钥，候选执行子进程则使用独立 Seatbelt 限制。

## 配置和请求

完整 TypeScript 类型在 [`src/service.ts`](src/service.ts)：`VerifierConfig`、`Binding`、`VerifyRequest`。stdin 只接受一个有界 JSON 请求，stdout 返回一个 JSON；通过退出 `0`，失败/阻断退出 `2`。调用方必须同时检查退出码和已验签结果。

配置由 root 安装，固定：

- `verifierId: "loopit-signer"`、`signerUid: 421`、Builder UID，以及互不重叠的 `inboxRoot`、`workRoot`、`evidenceRoot`。
- `runtime`、`runner`、`tests`、`source`、`goal`，各含绝对路径与**文件字节** `sha256:` 摘要。Runner 使用 [`src/runner.mjs`](src/runner.mjs)，tests 使用 [`fixtures/cases.json`](fixtures/cases.json) 的原始字节。
- `privateKeyPath` 与 `keyId`。keyId 是 Ed25519 公钥 **SPKI DER 字节**摘要；公钥由控制器另行固定，响应不提供替代信任根。
- `binding`：projectId、taskId、goalRevision、runId、goalDigest、sourceDigest、acceptanceDigest、criterionIds。

`goalDigest = digestOf(JSON.parse(goal 文件))`，`acceptanceDigest = digestOf(goal.acceptance)`，二者使用现有合同的 canonical JSON 算法；`sourceDigest` 是 baseline 源码文件字节摘要。不要混用 JSON 内容摘要和文件字节摘要。Goal 必须能被现有 `goal/1` 解析，`targetMatrix=[]` 且只有 `M0-CODE-01`；本包拒绝为其他目标签发 delivery Gate。

请求包含 `schemaVersion: "verify-candidate-request/1"`、唯一 `requestId`、inbox 内的单个 `.ts` 文件名 `candidateFile`、`candidateDigest`，以及与受保护配置**完全相同**的 `binding`。不接受 Builder 指定公钥、配置、测试、Runner 或输出路径。文件必须是允许的 Builder/root 拥有的普通文件；拒绝路径跳转、符号链接、硬链接、摘要不符或超过 64 KiB 的内容。

## 验证和签发次序

1. 检查固定配置、路径所有者/权限、输入摘要、目标及请求身份；读取候选快照。候选在 signer 内仅被解析和转译，从不执行。
2. 只允许单个 `sumEvenThrough(n)` 的有限纯函数语法。允许原实验中的数值判断、循环、算术及 RangeError；拒绝模块导入、顶层副作用、进程/文件/网络 API、动态属性和代码生成。超出该实验语法报告阻断，不能冒充通用 TypeScript 验证器。
3. 每个输入启动一个新子进程及受限 JS realm。父进程持有 12 项期望，子进程只接收单个输入与 nonce，返回观察值。父进程独立比较，不能用子进程自报 `passed`、JUnit 或测试计数通过。
4. 子进程 Seatbelt 默认拒绝网络、fork、信号和 IPC，只允许固定 Bun 可执行文件、系统库、固定 Runner 与不可写候选快照读取，以及独立 scratch 写入。没有 key、配置、tests 或 evidence 读取授权，也不继承父进程环境。250 ms VM 超时、3 s 子进程超时、16 KiB 输出界限；失败不退化裸跑，不自动重试。
5. 复核候选快照与全部受保护材料未变。先原子持久化 evidence 并同步文件/目录；只有 12 项真实结果全部符合时才构造 `GateDecision`，用现有 schema 与 `validateGate` 检查。
6. Ed25519 签名覆盖 Gate、完整 binding、候选/转译结果/测试/Runner/Bun 摘要与 evidence 引用；再原子持久化 attestation，成功后才返回。signatureRef 指向本次不可覆盖的 attestation 文件，不含自身摘要以避免循环引用。已存在的 requestId 拒绝重跑或覆盖。

通过响应的 `signedCheck = { payload, signature }`；签名消息是 `canonicalJson(payload)` 的 UTF-8 字节。`payload.gate.scope="delivery"` **仅表示这个 M0 代码执行任务的交付**，不能据此标记 M0 里程碑或 M1 成功。失败仅有未签名的失败证据，不发放通过 Gate。

控制器使用自身受保护的公钥调用 `verifySignedCheck`，提供固定 keyId、完整 binding、candidateDigest、testsDigest，然后检查受签名 Gate 和持久 evidence 的绑定。它不能接受响应附带的任意公钥。该 helper 校验签名和期望绑定，不替代 evidence 文件读取/摘要核对、证据保留或任务状态机。

接收结果时使用高层 `acceptSignedFixtureCheck(signedCheck, evidenceBytes, publicKeyPem, expected, window)`。它在纯验签之外核对证据原始字节、Gate 与证据身份，并要求调用者从受保护 Run 状态提供 `window.notBefore` 和原始预算 `window.deadlineAt`；默认使用真实当前时间，`window.now` 仅用于显式时钟测试。`observedAt`、`gate.decidedAt`、`evidence.finishedAt` 必须指向同一时刻；拒绝 Run 开始之前、未来、签发超过截止或接收已超过截止的证据。这里沿用该 Run 原始 60 分钟预算，不新设 TTL，也不重签历史证据。这是实链首次成功之后补上的接收检查；旧报告不能据此声称当时已运行此检查。

## 安装与验证边界

代码、TypeScript 编译器依赖、Runner、Bun、标准与配置必须由 root 安装到 Builder 不可写的路径；可用 `bun build --target=bun script/m0/verify-candidate.ts` 将父入口打成受保护 bundle，Runner 单独原样复制。work/evidence 根目录属于 signer 且为 `0700`；key 至少禁止 group/other 读写。inbox 目录本身属于 root/signer，若通过 ACL 允许 Builder 创建候选，Builder 不能替换该目录或改写受保护父目录。

路径所有者/Unix mode 检查不证明 ACL 和跨账户隔离已成立。正式部署必须另做 Builder 无法改 tests/key、子进程无法读取 key/测试或联网/fork/exec 任意程序的实际 OS 负例。生产入口没有关闭沙盒的选项。本包不生成或轮换生产密钥。

`bun test packages/verifier/test` 使用临时密钥、当前测试 UID 和真实无特权子进程验证协议、判定、篡改及签名；库级注入的测试执行器明确记录 `unverified-test-seam`，不能作为已完成 Seatbelt 或 UID421 隔离的证据。临时测试材料在测试后删除。独立身份的真实部署及 OS 实验由本轮集成验证另行记录。

## M0 CLI 部署证据接入

`bench milestone check --verifier-deployment <manifest.json>` 读取固定 root 信任索引 `/private/var/loopit/verifier-deployment-trust.json`。提交材料不能替换此路径、公钥、摘要或独立身份状态。索引与祖先路径检查 root 所有权、权限和 macOS ACL；所有输入拒绝符号链接、硬链接、特殊文件、过大文件及读取时发生的变化。

管理员可审阅并运行 [`install-verifier-deployment-trust.ts`](../../script/m0/install-verifier-deployment-trust.ts)：默认只读核验固定 job 的原受保护文件；显式 `--apply` 才新建只读导出与索引，任何已存在的目标均拒绝覆盖。它不读取签名私钥或 OAuth；内部读取 Signer 配置仅核对既有绑定，配置和私钥路径不进入导出。成功运行的旧 controller 摘要与后来 update9 安装的 controller 摘要分别保存；后者仍是 `applied-not-executed`。历史签名按已保护成功记录中的实际接收时点和原预算核对，这不改变旧代码当时缺少显式时效检查的事实。

注册只覆盖索引固定的 project/task/goalRevision/goalDigest/acceptanceDigest/Run；CLI 的 Goal 与 Run 不匹配就不建立独立身份。它不签发 M0 总验收，不认可其他 Goal 的签名，也不替代 M0-A01–A15 的独立证据。全部 15 项仍由原里程碑检查器判断，缺失时保持 blocked。`verifyDeploymentArchive` 是普通权限一致性测试接口；仅传入自制 trust 对象不能建立生产信任。
