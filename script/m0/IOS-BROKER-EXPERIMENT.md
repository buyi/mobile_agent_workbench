# 本机 iOS Broker 协议实验

这是 M0 设备协议的有限实验入口，默认只检查文件并生成计划。固定使用
`62F1C107-7480-41BD-B2E2-6C3323B8ECDA`，只接受 Loopit Test 模拟器包。
实际设备执行需要先审阅计划，再显式传 `--run`；运行时设备必须处于 Shutdown，目标 App 必须不存在。

```sh
bun script/m0/ios-broker-experiment.ts --out .bench/m0-fixes/ios-broker-plan
bun script/m0/ios-broker-experiment.ts --run \
  --plan .bench/m0-fixes/ios-broker-plan/plan.json \
  --out .bench/m0-fixes/ios-broker-actual
```

脚本使用普通操作账户，禁止 root。它会复制并复核计划中的包，启用指定模拟器，只安装一次，然后在 Ledger 回执边界注入丢失。查询口先注入不可用，确认同一操作及更换操作 ID 都无法重装；随后恢复只读查询，比较安装包全部字节，核对原操作。清理口再注入失败，确认设备隔离后才执行卸载、确认不存在、关机和确认 Shutdown，最后释放协议租约。

所有调用共用仓库 `.bench/m0-device-broker/device.sqlite` 中的 Broker 与 Operation Ledger，换一个输出目录不能绕过未释放租约。每个实际 simctl 命令前检查当前 token、generation、epoch 和 in-flight identity，并先保存意图。命令超时、输出不完整或结果未知均留下隔离，脚本不自动恢复、删除状态或重试安装。数据库回执使用 FULL；这不等同实机断电测试。

`result.json`、逐命令 stdout/stderr/意图/回执、安装包清单、查询和清理证明均保留在输出目录。实际运行结束后仍应核对原始报告；退出码和报告不是签名 Gate。

## 明确不能证明的部分

- SQLite 租约仅约束经本 Broker 入口的调用。相同 OS UID 仍能直接访问 simctl，尚无 OS 层独占和撤权，因此完整 M0-A08 保持未通过。
- Journal 使用同一主机上的独立进程与 SQLite 文件，未建立独立故障域或凭据域。
- 回执丢失、查询不可用、清理失败为明确标注的边界故障注入，不冒充真实进程崩溃。
- 本机模拟器安装是已选定的真实交付渠道。本实验尚未绑定正式 Task/Run 和签名 Gate，也没有 App 前台漂移/语义动作验证；完整 M0-A10 保持未通过，缺口不是必须发布到远端商店。
- 无设备测试只验证协议，不能替代真实 simctl 实验。真实实验另须明确授权执行。

无设备回归入口：`bun test script/test/ios-broker-protocol.test.ts`。调用时使用临时 XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME，避免个人 OpenCode 配置。

## 已执行的本机实验

2026-10-09 10:55:47Z–10:56:12Z 已在上述固定模拟器运行一次。真实安装次数 1、恢复查询次数 1，包摘要为 `sha256:5ea52ee3cde8666ab9842be6d9c5e46ce763044bb921822bdb1ea5e5736de519`。查询核对了全包字节，原 Operation 变为 succeeded；故障注入后的拒绝重派、旧 fence 拒绝及清理隔离均通过。随后真实卸载，listapps 确认目标不存在，关机后 list devices 确认 Shutdown，持久租约为 released。

原始证据在 `.bench/m0-fixes/ios-broker-actual-v1/result.json`，收尾摘要核对在同目录 `evidence-audit.json`：51 份引用文件摘要相符，SQLite 中原操作 succeeded、设备租约 released，无 in-flight 命令。收尾核对未新增设备操作。无设备回归为 9 tests / 67 assertions；整仓类型检查通过。以上均为本机渠道协议实测，仍受上述 OS 独占、正式 Run 绑定及签名 Gate 缺口限制。
