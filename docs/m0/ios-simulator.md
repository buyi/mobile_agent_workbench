# M0 iOS 模拟器能力实验

日期：2026-10-09。用户选定 iOS 模拟器，交付范围为本机 `.app`、安装、验证及卸载或恢复基线。以下是工具链与安装身份的实测记录，M0 整体仍未通过。

## 构建来源

| 项目 | 固定输入 |
| --- | --- |
| 仓库 | `leap_loopit_rn` |
| 基线 | `release/1.3.50` / `9874bd473cfb3f9603bb580a2085e68983eb98fa` |
| 独立副本 | `.bench/workspaces/loopit-m0-ios` |
| 准备补丁 | `ios/Podfile.lock` 中 NativeAds、NativeFeed 的本地 podspec 摘要，共两行；没有改变依赖版本 |
| 补丁 SHA-256 | `46d6ef18db0b471635c77bd4cdab2dc7feb64ee8abe91282764f8c6107a437f0` |
| 工具链 | Xcode 26.0.1 / iOS Simulator SDK 26.0；Node 20.19.4、npm 10.9.8；Ruby 3.3.11、Bundler 2.5.23、CocoaPods 1.16.2 |
| 依赖安装 | `npm ci` 固定 lock；`pod install --deployment --no-repo-update`，234 pods |
| 构建配置 | `leaprn` workspace/scheme，`ReleaseTest`，`APP_ENV=test`，arm64，禁用签名与 Sentry 自动上传 |

原基线的两个 podspec checksum 与仓库内 podspec 不一致，第一次 deployment 安装因此拒绝。修复仅发生在独立副本，补丁保存在 `.bench/m0-fixes/ios-local-podspec-checksums.patch`。本次成功证明“基线加记录的修复”能构建，不能写成原样基线已经重现。

原基线 `ios/Podfile.lock` 摘要为 `sha256:bdfb928dbb0130619c3072bab8a5bde731dd1cc85f32394e1979da0d4c38f18d`；两行修复后实际输入为 `sha256:82b23dee36e45451e4f2d917da09cf14b82d72772392df83a66cbc7603b61c27`。整理 M1 材料时发现旧 preflight 的构建输入栏仍使用前者，已保留旧字节副本 `ios-preflight-before-lock-metadata-correction.json`，在新记录中分开 baseline 与 prepared 摘要，并记录纠正时间和来源。此次重新核对确认 HEAD 与补丁匹配，没有重跑或补写一次构建成功事件。

构建命令在独立副本执行：

```sh
APP_ENV=test EXPO_NO_TELEMETRY=1 RCT_NO_LAUNCH_PACKAGER=1 \
SENTRY_DISABLE_AUTO_UPLOAD=true \
xcodebuild -workspace ios/leaprn.xcworkspace -scheme leaprn \
  -configuration ReleaseTest -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /Users/buyi/Documents/bench/.bench/m0-fixes/ios-derived-data \
  -resultBundlePath /Users/buyi/Documents/bench/.bench/m0-fixes/ios-build.xcresult \
  -jobs 4 CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build
```

复跑须使用新 resultBundlePath，先按 `.bench/m0-fixes/ios-preflight.json` 核对锁文件、补丁与工具链；本机路径不能当作已部署 Worker 的安装说明。

## 产物与安装核验

产物位于 `.bench/m0-fixes/ios-derived-data/Build/Products/ReleaseTest-iphonesimulator/Loopit (Test).app`。

| 身份 | 实测值 |
| --- | --- |
| bundle / version / build | `com.seedleap.loopitapp.test` / `1.3.50` / `98` |
| 包内容摘要 | `sha256:5ea52ee3cde8666ab9842be6d9c5e46ce763044bb921822bdb1ea5e5736de519` |
| 可执行文件摘要 | `sha256:95b6691027b74c6b5f2d65d09470cfaee39e95c321cdbf36d44d38f64d5e2129` |
| `main.jsbundle` 摘要 | `sha256:7da0ef9a437f9d25e1f615e31a94454288a68fe6b3944085da01542f1b2e5977` |
| 专用设备 | iPhone 17 Pro，iOS 26.0，`62F1C107-7480-41BD-B2E2-6C3323B8ECDA` |

包内容摘要由排序后的文件路径、字节摘要、大小及相对符号链接组成，不纳入安装目录、所有者、mtime 或空目录。拒绝逃逸包目录的链接；安装后重新读取实际 App 容器，逐文件比较。版本号只是身份的一部分。

[`ios-simulator-probe.ts`](../../script/m0/ios-simulator-probe.ts) 实际完成：

1. 专用模拟器启动，独立确认目标 App 尚未安装。
2. 安装原包，实际容器内容与构建包一致。
3. 启动并立即截图；截图处于启动动画，**不证明页面已就绪或功能通过**。
4. 停止 App，安装一个保持相同版本号、但修改了 `main.jsbundle` 的副本。该副本从未启动；检查准确拒绝其内容身份。
5. 恢复原包，重新核对内容一致；卸载后查询确认 App 不存在，关闭后查询确认模拟器为 `Shutdown`。

首轮在安装前因 `simctl listapps` 返回 OpenStep plist 而非 JSON 停止。修复为系统 `plutil` 转换后，显式核对前次创建记录、实际设备身份、无安装派发和 App 不存在，复用同一设备完成实验，没有新建第二台或盲目重放不确定安装。

原始报告：`.bench/m0-fixes/ios-simulator-install-v2/result.json`。构建清单、各次安装清单、命令回执、截图保存在同目录；`.bench/m0-fixes/ios-preflight.json` 汇总构建、源码与锁文件。

首次卸载后的即时查询未发现 App，但下一次启动出现安装占位记录。实验因此停止，显式清除这台专用设备的残留；后续 UI 实验增加跨重启复核，同时检查 App 列表与实际容器均不存在。最终 App、新安装的 Runner 均已卸载，设备为 `Shutdown`，私有 daemon 与 Runner 进程已退出。不能只用卸载命令返回成功证明清理完成。

只生成本地清单：

```sh
bun script/m0/ios-simulator-probe.ts \
  --artifact '<absolute path to simulator .app>' --out '<new report directory>'
```

增加 `--run` 才会创建专用模拟器并执行完整安装实验。输出目录存在时拒绝覆盖；失败后必须检查动作结果，默认不重试。脚本只接受 Loopit 测试 bundle 与 simulator 包，不接受物理设备。

## 语义操作与前台检查

语义工具复用已有 `mobile-ui-runtime` 的 core/provider 及 MIT 许可的 `agent-device@0.21.1`，没有引入第二套 Agent 循环。独立状态目录中的实际实验点击了 Loopit 的本地调试入口，取得新观察；过期 revision 被 `stale_snapshot` 拒绝，provider 派发为 0。实验未登录、复制信息或改变业务配置。报告副本位于 `.bench/m0-fixes/ios-ui/`。

发现原工具的 session 元数据不能证明 App 的实时前台状态，而且 snapshot 可能主动激活目标 App。因此新增一个由本仓库维护的最小 Runner 补丁，只在私有副本使用：

- [`ios-runner-state.patch`](../../script/m0/ios-runner-state.patch)：3 个 Swift 文件、139 行 diff，新增只读 `XCUIApplication.state` 查询，在任何激活或 snapshot 前执行。
- [`ios-runner-state.lock.json`](../../script/m0/ios-runner-state.lock.json)：固定上游版本、原文件和补丁摘要；不匹配时拒绝使用。补丁 SHA-256 为 `22a86f5abebf7ccc82ac014938de9c02254a9d486a30b66d7ee2bd65cac2cb4a`。
- [`ios-state-adapter.mjs`](../../script/m0/ios-state-adapter.mjs)：核对本地 Runner 租约、nonce、实际 UDID、状态与时间界限；无可靠观测就阻断，不回退为 session 声明。
- [`ios-state-probe.mjs`](../../script/m0/ios-state-probe.mjs)：准备、构建及实测入口。上游共享工具安装与 OpenCode submodule 均未修改。

实测先确认 Loopit 前台，随后切到系统设置。切换期间曾观察到两个 App 同时返回前台值，因此等待到连续两次 `Loopit=background`、`Settings=foreground` 才执行负例检查。适配层返回 `app_drift`，action/snapshot 派发均为 **0**，只读查询后设置仍在前台。观察窗口的 Runner 日志没有激活、snapshot 或动作调用；21 项适配器回归、50 个断言通过。证据副本位于 `.bench/m0-fixes/ios-foreground/`。

XCTest 状态异步更新；连续采样不构成 OS 原子焦点保证，也不能消除采样与执行之间的外部切换。该补丁仅证明观察与拒绝能力，不代表已建成统一 Broker、持久设备独占或完整 M0-A08。

## 专用 UID422 私有设备集实测

2026-10-09 另建了 `loopit-device-probe`（UID/GID 422）和权限为 `0700` 的私有 home、device set。首次预检的第一个 `simctl --set ... list devices -j` 在 15 秒超时；清理阶段随后成功观察空集及三次进程、`user/422` 域为空。该次报告保持 `blocked`，一次冷启动超时不代表 OS 不支持私有设备集。

独立恢复实验固定前次报告、原 runner 和计划摘要，复核当前停止状态；只把首次 list 上限改为 60 秒，总预算仍为 6 分钟。原始报告位于 `.bench/m0-fixes/device-private-set-actual-v2/result.json`，SHA-256 为 `4aa0318b09ccfd912ef93aeec4a9ff2ed40b677cab357c4589dc9e7aedec8c09`，仍保留 `status=blocked`、`phase=maintenance`。逐条回执可确认：

- UID422 实际观察空集、创建新设备 `8C48B494-D182-4788-A4F9-B53F97CA69D0`，按实际 UDID 核对身份后启动并观察 `Booted`；此设备与原正式设备 `62F1C107-7480-41BD-B2E2-6C3323B8ECDA` 不同，未改变原 Goal 的绑定。
- UID501 使用真实主 GID 20 和实际内核 groups，能读取公共 canary 并执行 `simctl help`；打开私有目录、私有 canary 均收到 `EACCES`。对明确私有路径的 list 返回 exit 1、空 stdout 和 `Provided set path does not exist: ...`。其前后 UID422 均观察到同一设备仍为 `Booted`，因此可以确认 UID501 此次无法通过该私有路径枚举设备。
- 脚本要求拒绝文本包含 permission 等关键词，未把上述路径错误归类为 IPC 拒绝，因此在 UID420 分支前停止。这里保留原判定，不把私有路径不可见扩大为 CoreSimulator 原生 IPC、默认集合或跨用户 UDID 控制隔离。
- 清理实际完成 shutdown、观察 `Shutdown`、删除该新设备、再次观察空集；专用 UID422 清理后有连续三次进程和域为空的记录。无模型调用、App 安装或正式设备操作，原前次材料摘要保持不变。

随后独立的 Worker 空集合负例已完成。报告 `.bench/m0-fixes/worker-private-set-actual-v1/result.json` 的 SHA-256 为 `d78ff9bdc46f118eaac808ea8773953d3c423d8f68a3db121db8745e6899df01`。7 条固定命令显示：UID420 的实际 UID/GID 均为 420、内核 groups 为 `[420]`，公共 canary 和 `simctl help` 成功；私有目录、canary 返回 `EACCES`，明确私有路径的 list 返回上述 path-not-exist 错误。UID422 在其前后均成功列出同一空集合并读取私有 canary。没有使用已删 UDID，没有设备变更或 App 安装。

该次控制器报告保留 `private-path-observed-worker-stop-pending` 和 `phase=maintenance`；其后的 `host-result.json` 绑定同一 controller/plan 摘要、scope `3243d7da-7c2d-4a93-9c16-bfeb1fc4875c`、generation 20，确认 controller exit 0、Supervisor 最终 `stopped`。UID420、UID421 的最终停止证明均属于该 scope，晚于控制器完成时间；UID422 的停止证明位于绑定的控制器报告中。三个身份均有连续三次进程及服务域为空的观察。`independent-audit.json` 核对了这些绑定、实际命令和摘要，原始报告字节未改。此项有限私有路径实验完成，M0-A07/A08 仍为部分完成。

## 生产设备路线的最小下一步（仅方案）

已检查本机锁定的 `agent-device@0.21.1` 私有副本：上游 CLI 提供 `--ios-simulator-device-set`，内部 `simctl` 从 `simulatorSetPath` 生成 `--set` 参数；managed lease admission 也比较该路径。XCTest 路线已有设备集锁，临时把该执行身份 home 下的 `Library/Developer/XCTestDevices` 指向选定集合，并在 release 时恢复；私有集合不会直接认领其他已存在的 detached Runner。我们此前的实验脚本使用默认集合，不代表上游缺少这项能力。后续复用这些机制，不再实现另一套 Runner。

这次是源码检查，原始文件摘要记录于 `.bench/m0-fixes/agent-device-private-set-source.json`，不构成 UID422 实测或 OS 独占证明。受保护执行器仍须固定实际 UID、HOME、集合和 Runner 身份，并核对 XCTest 链接与锁的恢复；不能把普通操作者的 home 传入该路线。

将后续工作合并为一次正式路线接入和活目标验证，不再用零散空路径实验代替设备控制边界：

1. **固定设备绑定。** 可信控制面保存 resource ID、owner UID422、规范化 private set、实际观察的 UDID/runtime/device type、binding revision 和 registry 摘要。新私有设备必须经明确的新 Goal revision 绑定；不能替换原 Goal 的 `62F1…` 设备。当前能力注册继续拒绝 autonomous 请求，不能凭 `probe` 标志或手填 `osExclusive=true` 放行。
2. **受保护的有限命令入口。** 给现有 Broker 接一个本机固定命令 port，沿用现有 operation journal、fence 和租约检查，不另建 Agent 循环。请求携带 Task/Run/Goal revision、scope/epoch/generation、operation ID、request digest、binding/registry digest，以及枚举动作和必要产物摘要。可信控制器从已接受任务核对授权，再通过受保护入口以 UID422 执行固定命令；不接受 shell、任意 argv、任意 set 或替代 UDID。query/reconcile 不派发新副作用，回执丢失保持 unknown。Runner 的选择、启动及语义观察也必须实证绑定同一私有 set/UDID；现有默认集合路径不能直接宣称兼容。
3. **一次活目标旁路与正式路径实验。** 在串行 Supervisor scope 内，由 UID422 新建唯一实验设备，观察准确 UDID、身份和 Booted 状态，保留前后 owner 正例。UID420 使用实际 Worker 身份和工具基线，尝试明确私有 set、以及不传 `--set` 的默认集合枚举与针对该活 UDID 的有限直连；可选择仅作用于该新设备的可逆 rename，并由 owner 前后核对名字及状态。只使用准确 UDID，禁止 `all`、`booted` 或旧正式设备；若直连成功，记录旁路成立并由 owner 恢复，保持 production blocked。若失败，也只确认被测入口；完整原生 IPC 隔离还须由选定的 OS 策略及 Runner/工具实际访问面证明。随后通过受保护 Broker 路径完成同一设备的安装身份、语义动作、签名证据与清理，测试过期 fence、重放和回执丢失均不重复派发。

默认集合控制失败必须针对 owner 当时仍可操作的真实目标，不能以设备已删除或工具不可用为“隔离通过”。收尾核对唯一实验设备删除、私有集合为空以及三 UID 的停止证明。此处只有接口与实验方案，尚未增加生产 port、执行默认集合旁路实验或授予设备 OS 独占能力。

## 尚未证明的能力

- 随后的 [本机 Broker 协议实验](../../script/m0/IOS-BROKER-EXPERIMENT.md) 已实测持久租约、generation/epoch、回执丢失核对、清理隔离和最终卸载关机；它仍是操作者权限下的有限实验，同机 Journal 不满足独立故障域。
- 安装、语义操作与前台拒绝各有局部证据；设备 OS 独占，以及这些结果在正式 Task/Run 下的统一绑定尚未完成。当前 [设备能力入口](../../script/m0/DEVICE-CAPABILITIES.md) 会拒绝该资源的自主任务派发，实验 scope 不是 OS 独占授权。
- 没有远端渠道发布或 TestFlight 实验，也没有独立身份签发的 InstallReceipt / GateDecision。
- 真实模型编辑实验只修复临时函数；诊断信息页属于 M1，尚未开发。
