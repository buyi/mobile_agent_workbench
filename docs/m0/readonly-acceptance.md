# M0 A12：控制器接受入口的只读部署复验

`-d` 已于 **2026-10-09 12:45:22 UTC** 完成真实 root 部署复验：新 bundle 在禁止写文件、联网和派生进程的 Seatbelt 中运行，退出码为 **2**、stderr 为空，stdout 精确返回 `evidence_acceptance_rejected:acceptance_deadline_exceeded`。独立只读审计 **43/43 通过**。这证明新部署入口按真实时钟拒绝过期证据；A12 的完整十五项证据装配仍为 **partial**，完整 M0 尚未通过。

历史 update9 的 `finalize` 在时间窗检查前会写 Delivery 状态、保存候选并启动 Signer，不能为了验证过期拒绝而重跑。这里新增控制器 `readonly-acceptance` 分支，在加载 Runtime、Delivery、上下文恢复模块或创建 reports 之前返回。正常 finalizer 与只读分支调用同一个 `requireSignedFixtureAcceptance`，其内部仍调用原有 `acceptSignedFixtureCheck`，并保留相同的 `evidence_acceptance_rejected:<reason>` 错误路径。

这次安装使用**单独的新 bundle 和目录**，不替换 update9，也不代表 update9 的正常 finalizer 曾重新执行。旧成功 Run、原 deadline `2026-10-09T11:08:25.455Z`、签名、Runtime reservation 和历史 bundle 均不修改。只读分支只接受固定历史 Run/keyId/九个 root 保护文件及摘要，没有时钟参数；即使传给共用函数的对象包含额外 `now`，也不会转发。stdout 输出拒绝结果，exit2 保留接受检查失败的语义。

本地测试已通过 10/10、57 断言（7 个只读测试及 3 个原恢复测试）；其中独立 Bun 子进程构建最终 bundle，再以普通 UID 运行只读坏路径入口，验证未初始化 HOME/XDG/数据库。该测试只模拟 JS 身份 getter 以走入分支，没有更改 OS 身份；真实 root/Seatbelt 部署证据单独归档。使用实际旧签名材料的测试确认：签名仍有效、真实当前时间已超期、错误 Run/预算/签名/证据失败。没有重新签名或调用模型。typecheck 通过。

实际报告为 [`actual/result.json`](../../.bench/m0-fixes/readonly-acceptance-actual-d/actual/result.json)，SHA-256 为 `e0f0f918d4e5bedaf964f2f0cd1426d381112374d840fce4ff70f145e11b3fac`。[`independent-audit.json`](../../.bench/m0-fixes/readonly-acceptance-actual-d/independent-audit.json) 的 SHA-256 为 `d8f74d5463ba4ba5caddd2412419cac5b9b34350506d29d3cecb4c57cf9d4733`；审计复核了原始归档、安装计划、root 驱动、受保护安装文件、源文件 pin 及执行前后清单，没有再次执行管理员动作。

实测 `checkedAt=2026-10-09T12:45:22.256Z` 位于捕获的进程运行区间内，晚于原 deadline。原 Run `run-46a51a51-d1ce-45f2-83f6-719cc4fc2bb8` 仍绑定 `repairIndex=2/maxRepairs=3`；九个历史输入和 update9 的前后摘要全部一致。只读入口没有打开数据库、调用模型、启动 Signer 或释放 reservation。历史成功 bundle、update9 与新只读 bundle 是三个不同的摘要；**旧 update9 finalizer 没有重跑**。

冻结材料在 `/private/tmp/loopit-readonly-acceptance-stage-20261009-d`：

| 文件 | SHA-256 |
| --- | --- |
| `plan.json` | `a43899d4d9239fafa8aed8ce5b6ae937242ce64c2047dc088986415332ecb994` |
| `controller.mjs` | `20f88badb28dbcaae0beb8239a43526828c71bb6eab6866da4b1a1f002db7d63` |
| `install-readonly-acceptance.py` | `ce09f33b46cfa4cbc8932b39adbec7449610d7d54bf5b6c154294663b4cc5417` |

`-c` 的实际 root 安装已被正确拒绝，未安装该 controller、未执行只读入口：公开 `signedCheck.json` 重序列化后的摘要为 `6ae5764a…3764e3f`，原受保护 `signed-check.json` 摘要为 `f19125bc…a0e9c4`。`-d` 先验证公开导出的 trust pin、两份 JSON 的完整签名内容等价以及真实公钥签名，再使用 root 已观察且历史归档一致的**原字节** pin。计划保存两种摘要和验证来源；没有重写旧文件或放宽安装器检查。[`-c` 安装失败记录](../../.bench/m0-fixes/readonly-acceptance-actual-c/actual/install.json) 保留。

普通权限安装器校验曾返回 `verified-not-installed`；随后 root 驱动已完成安装，安装回执退出码为 0。下面保留当时审阅的安装参数。实际驱动先把安装器复制到受保护目录并重验摘要，再执行安装；新目录现已存在，安装器会拒绝重复安装或覆盖。安装器在创建新目录之前核对了历史文件和 update9 的现存摘要。

```sh
/usr/bin/python3 /private/tmp/loopit-readonly-acceptance-stage-20261009-d/install-readonly-acceptance.py \
  --stage /private/tmp/loopit-readonly-acceptance-stage-20261009-d \
  --plan-digest sha256:a43899d4d9239fafa8aed8ce5b6ae937242ce64c2047dc088986415332ecb994 \
  --apply
```

实际 root 驱动把工作目录设为新安装目录，显式提供下面的干净环境，关闭 Bun 自身转译缓存；Seatbelt 拒绝文件写入、网络和派生进程。驱动通过管道捕获 stdout/stderr/退出码，保存到新的 `-d/actual` 报告目录。下面是与已执行命令等价的环境和参数，原始驱动见 [`run-reviewed.py`](../../.bench/m0-fixes/readonly-acceptance-actual-d/run-reviewed.py)。

```sh
/usr/bin/env -i PATH=/usr/bin:/bin LANG=C HOME=/var/empty \
  XDG_CONFIG_HOME=/var/empty XDG_CACHE_HOME=/var/empty \
  XDG_DATA_HOME=/var/empty XDG_STATE_HOME=/var/empty \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
  /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny file-write*)(deny network*)(deny process-fork)' \
  /private/var/loopit/m0-runs/m0-code-loop-20261009a/bin/bun \
  /private/var/loopit/readonly-acceptance-m0-20261009-d/controller.mjs \
  --phase readonly-acceptance \
  --plan /private/var/loopit/readonly-acceptance-m0-20261009-d/plan.json
```

本次已同时满足：exit2、stderr 为空、stdout `status=rejected` 且精确超期拒绝；真实 `checkedAt` 晚于原 deadline；九个输入和 update9 前后摘要一致；原 Run 与预算不变。其他错误、权限拒绝、超时或无 stdout 仍不能算时间窗路径通过。此结果只完成新部署接受入口的时间窗负例，不替代完整 A12 证据装配或 M0 验收。
