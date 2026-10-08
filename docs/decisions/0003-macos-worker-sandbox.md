# ADR-0003：macOS Worker 隔离采用 Seatbelt + 专用低权限账户

日期：2026-10-08。状态：**已接受（实现完成，macOS 实测未完成）**。决策依据：用户确认“主要在 mac 上使用”，采用 Seatbelt + 专用低权限用户。上游：[主规格 §5.5](../loopit-workbench-spec.md#55-沙盒与资源)、[M0-F07](../milestones/m0-contracts-and-integration.md#m0-f07-沙盒与凭据)。

## 决定

1. 沙盒是 Worker 内的统一接口（`packages/sandbox/src/contract.ts`）：输入 `SandboxPolicy`（工作目录、额外可写目录、禁读目录、网络模式、完整环境变量），输出可执行的受限命令与规则摘要。Shell 与 OpenCode 内置工具都必须经过它；进程生命周期由 Supervisor 负责，不在沙盒接口内。
2. macOS 后端用 Seatbelt（`/usr/bin/sandbox-exec`）：
   - 默认拒绝；写入只允许工作目录与声明的目录；
   - 读取默认允许（工具链需要），显式禁读操作者 home、其他 Attempt 等；
   - 网络 `none` 不开放任何 socket，`proxy` 只允许 `localhost:<出口代理端口>`；
   - 不开放钥匙串（SecurityServer）、直接 DNS（dnssd）等系统服务；
   - 路径以 `-D` 参数传入，不拼进规则文本；`/tmp`、`/var`、`/etc` 规范化为 `/private/...`。
3. 第二层是账户隔离：`loopit-worker` 运行 Worker 与全部沙盒命令，`loopit-signer` 持有签名身份，两者 home 均为 700、无登录 shell、无密码、隐藏（`script/macos/setup-worker.sh`）。即使 Seatbelt 规则有误，Unix 权限仍阻止读取操作者与签名账户的文件。
4. Linux 后端（bubblewrap）保留接口位置，暂不实现。

## 已知限制

| 限制 | 影响 | 处理 |
| --- | --- | --- |
| `sandbox-exec` 在手册中标为弃用 | 未来 macOS 可能移除 | 每次升级 macOS 重跑 `sandbox-contract`；失败按本 ADR 重新评估（候选：Tart 虚拟机） |
| 无 PID 命名空间 | 子进程对同用户的其他进程可见、可发信号；`setsid` 可脱离进程组 | 能力矩阵 `processIsolation = limited`；Supervisor 需按进程树核对，不能只杀进程组 |
| 读取默认允许 | 未列入禁读、且对 `loopit-worker` 可读的文件可被读取 | 账户隔离兜底；setup 脚本提示操作者 home 权限 |
| Xcode/模拟器需要额外系统服务 | 当前规则下 iOS 构建大概率失败 | 构建与设备控制走独立的构建代理和设备 Broker（T04），不放宽 Agent 沙盒 |
| 出口代理尚未实现 | `proxy` 模式目前只保证“只能连本机该端口” | 代理与域名白名单另行实现 |

## 验证

`bun script/bench.ts verify --suite sandbox-contract` 必须在 macOS 上以 `loopit-worker` 身份运行。每个负向用例先证明动作在沙盒外可以成功，再断言沙盒内失败。在 Linux 上运行该套件返回 `blocked`。macOS 上通过之前，能力矩阵中相关项一律保持 `unverified`。
