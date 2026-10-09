# ADR-0003：macOS Worker 隔离采用 Seatbelt + 专用低权限账户

决定日期：2026-10-08；实测更新：2026-10-09。状态：**已接受（macOS 部分实测通过，完整隔离未验收）**。决策依据：用户确认“主要在 mac 上使用”，采用 Seatbelt + 专用低权限用户。上游：[主规格 §5.5](../loopit-workbench-spec.md#55-沙盒与资源)、[M0-F07](../milestones/m0-contracts-and-integration.md#m0-f07-沙盒与凭据)。

## 决定

1. 沙盒是 Worker 内的统一接口（`packages/sandbox/src/contract.ts`）：输入 `SandboxPolicy`（工作目录、额外可写目录、禁读目录、网络模式、完整环境变量），输出可执行的受限命令与规则摘要。Shell 与 OpenCode 内置工具都必须经过它；进程生命周期由 Supervisor 负责，不在沙盒接口内。
2. macOS 后端用 Seatbelt（`/usr/bin/sandbox-exec`）：
   - 默认拒绝；写入只允许工作目录与声明的目录；
   - 读取默认允许（工具链需要），显式禁读操作者 home、其他 Attempt 等；
   - 网络 `none` 不开放任何 socket，`proxy` 只允许 `localhost:<出口代理端口>`；
   - 不开放钥匙串（SecurityServer）、直接 DNS（dnssd）等系统服务；
   - 路径以 `-D` 参数传入，不拼进规则文本；`/tmp`、`/var`、`/etc` 规范化为 `/private/...`。
3. 第二层采用专用账户：计划由 `loopit-worker` 运行 Worker 与全部沙盒命令，`loopit-signer` 持有签名身份，两者 home 要求为 700、无登录 shell、密码认证禁用、隐藏（`script/macos/setup-worker.sh`）。本机已通过系统管理员认证创建这两个账户（UID 420 / 421）并审计，root harness 的两项跨账户私有文件拒绝实验已通过。账户属性和 home 权限检查不能证明操作者与 signer 文件已隔离，必须分别做跨账户读拒绝实验。
4. Linux 后端（bubblewrap）保留接口位置，暂不实现。

## 已知限制

| 限制 | 影响 | 处理 |
| --- | --- | --- |
| `sandbox-exec` 在手册中标为弃用 | 未来 macOS 可能移除 | 每次升级 macOS 重跑 `sandbox-contract`；失败按本 ADR 重新评估（候选：Tart 虚拟机） |
| 无 PID 命名空间 | 子进程对同用户的其他进程可见、可发信号；`setsid` 可脱离进程组 | 能力矩阵 `processIsolation = limited`；Supervisor 需按进程树核对，不能只杀进程组 |
| 读取默认允许 | 未列入禁读、且对 `loopit-worker` 可读的文件可被读取 | 必须验证操作者与 signer 文件的真实读取边界；setup 不修改操作者 home 权限，不能声称账户隔离已兜底 |
| Xcode/模拟器需要额外系统服务 | 本机模拟器构建已成功，但未证明构建处于该 Agent 沙盒或设备边界已验收 | 构建与设备控制走独立构建代理和设备 Broker（T04），其权限边界仍需验证 |
| 自有出口策略与域名白名单未实现 | `proxy` 模式只保证“只能连本机该端口”；真实编辑实验复用既有 `localhost:7897` 代理 | 对代理的目的域名控制仍需另行实现，不能据端口可达宣称已限制目的域名 |

## 专用账户的配置边界

`script/macos/setup-worker.sh` 默认执行 `--audit`，只读检查账户、组、home 所有权/模式及 ACL 等；账户缺失时返回 blocked。`--dry-run` 仅输出拟执行命令。只有显式 `sudo script/macos/setup-worker.sh --apply` 才会创建缺失的专用账户和目录。已有记录不符合策略时停止，不自动修复；本轮已由用户明确要求执行，并通过 macOS 原生管理员认证完成创建与独立跨账户实验。

```text
bash script/macos/setup-worker.sh --audit
bash script/macos/setup-worker.sh --dry-run
```

`probe()` 实际检查 UID、组、登录属性、home 权限等，不能仅凭用户名把 `userIsolation` 标记为 supported。实际跨账户读取还需要不含秘密的 fixture、独立的所有者侧成功读取基线，以及 Worker 侧拒绝证据。不得为了通过测试给 Worker 一般 sudo 权限。

## 验证

2026-10-09 正式结果为 **28 passed / 2 notRun / 0 failed**，记录在 `.bench/m0-fixes/sandbox-after-account-parser/result.json`。套件仍返回 `blocked`、退出码 2；该次套件以操作者身份运行，两项内置跨账户用例仍为未执行；另由 root harness 在真实 Worker 身份下完成两项独立文件实验，报告见下表，不能据此静默把原套件改成全通过。

| 验证项 | 本轮结果 |
| --- | --- |
| 本地文件、子孙进程、符号链接和 TCP 限制 | 相关用例通过，包含错误进程与有界超时诊断 |
| 公网 TCP `none` / `proxy` | 同一 IPv4 端点 `111.132.47.193:443` 在沙盒外可连接，在两种沙盒模式下直接连接均被拒绝；基线与拒绝阶段不重新解析主机名 |
| 先前的 `1.1.1.1:443` 基线 | 当时该地址不可达，不能据此判定公网整体不可达，也不能计为沙盒拒绝证据 |
| 操作者与 signer 跨账户读拒绝 | root harness 的 owner 基线与 Worker 拒绝两项通过，实际 UID 501/420/421；`.bench/m0-fixes/account-isolation/result-audited.json`。内置套件尚未接入这个独立 root 调度路径，仍为 2 notRun |

本地 TCP 限制使用独立用例。每个负向用例必须先证明动作在沙盒外可成功，再断言沙盒内被拒绝。本轮固定端点命令如下；后续重跑仍需重新验证该端点可达性，不能沿用旧基线推断新结果。

```text
LOOPIT_SANDBOX_PUBLIC_IPV4=111.132.47.193 bun script/bench.ts verify --suite sandbox-contract
```

另一次真实 OpenCode 编辑实验也使用本后端：模型进程仅可连接现有本机 7897 代理端口，可写范围为临时工作区和独立运行态目录；操作者 home 与原认证目录禁读。凭据只通过原生 access-only 环境传入，不提供 refresh token。固定测试和可执行文件位于模型不可写目录；模型候选在独立 `network=none`、无凭据环境中通过 12 项测试。该记录支持本次有界实验，尚不证明独立签发 Gate、完整进程树 Supervisor 或完整 Worker 与签发服务隔离。

完整 `sandbox-contract` 仍需在配置完成的 `loopit-worker` 身份下补齐跨账户前置条件后重跑。Bun 对跳过用例可能返回 0；`bench` 将 skipped 记录为 `notRun`，只要必需用例未执行，套件 verdict 就是 `blocked`、退出码 2。在 Linux 上也返回 blocked。当前 Seatbelt 文件及选定 TCP 端点行为已有实测，整体能力仍为 limited；账户文件边界已有真实正反例，生产 Worker/签发服务尚未部署，不能据基础用例宣称整个沙盒或 M0 完成。
