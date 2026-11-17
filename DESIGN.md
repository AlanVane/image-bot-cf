# image-bot-cf — 将 Imgbot 重建于 Cloudflare 的设计文档

- 状态：草案 v0.1（2026-11-16），待评审
- 目标：在 Cloudflare 基础设施上复刻 [imgbot/Imgbot](https://github.com/imgbot/Imgbot) 的**全部功能与使用体验**（GitHub App → 自动优化图片 → 开 PR）
- 依据：对 imgbot/Imgbot 源码的逐目录调研 + Cloudflare 官方限额文档 + 本地 WASM 编解码基准（`bench/bench.mjs`，随仓库保留可复现）
- 项目名/目录名：`image-bot-cf`

---

## 1. 目标、范围与验收标准

### 1.1 功能对等清单（P1–P3 完成 = 对等）

- [x] GitHub App 安装到 repo/org 后，对每个选中仓库自动开一个优化 PR
- [x] push 到默认分支且触碰图片或 `.imgbotconfig` 时自动重跑
- [x] 单一长驻 `imgbot` 分支；重复运行**原地更新 PR**（不新开）
- [x] 格式支持：`.png .jpg .jpeg .gif .svg`（大小写不敏感）
- [x] 默认无损；`aggressiveCompression: true` 切有损（JPEG/GIF 已通；PNG 有损暂缺——实测 wasm 方案 quality 为 no-op，见 §6.1）
- [x] commit message / PR body / 分支名 / PR 标题**逐字复刻**（§2.2）
- [x] `minKBReduced` 阈值（默认 10，≤0 表示无阈值）
- [x] `.imgbotconfig` 全字段：`schedule` / `ignoredFiles` / `aggressiveCompression` / `compressWiki` / `minKBReduced` / `prTitle` / `prBody`
- [x] 合并 PR（merge 或 squash，≤2 commits）后自动删除 `imgbot` 分支
- [x] 人类 push 到 `imgbot` 分支 → 中止运行（"branch has been modified by the user"）
- [x] 人类改坏 `imgbot` 分支后卡死 → 定时巡检恢复 PR（原版 30 分钟毒队列巡检）
- [x] `schedule: daily|weekly|monthly` 定期重优化
- [x] `compressWiki: true` 时同时优化 `<repo>.wiki`
- [x] 人工触发入口（原版仪表盘 "Request new optimization"）→ P3 仪表盘（2026-11-17 落地，`public/` + `src/dashboard/`）
- [x] PR 里能看到逐文件降幅表 + 总降幅（≥5% 才显示百分比）

### 1.2 故意偏差登记（与原版不同，均为主动决策）

| #   | 偏差                                                                                                                                                                                                                                                                 | 理由                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | webhook 增加 HMAC 签名校验（原版不验签）                                                                                                                                                                                                                             | 安全基线，行为只增不减                                                                                                                                          |
| D2  | `prTitle`/`prBody` 不设付费墙，全员可用                                                                                                                                                                                                                              | 无 Marketplace 计费层（P3 前）                                                                                                                                  |
| D3  | 计费/Marketplace/私有仓配额整体延后到 P3                                                                                                                                                                                                                             | 复刻体验 ≠ 复刻商业层                                                                                                                                           |
| D4  | 不整库 clone，走 Git Data API 读写                                                                                                                                                                                                                                   | 等价输出，去掉 LibGit2Sharp/容器依赖                                                                                                                            |
| D5  | `imgbot` 分支每轮重建为 base + 单 commit（**暂存分支中转**：commit 先落 `imgbot-staging-<runId>`（按 run 唯一，2026-11-17 P1 修复并发互踩）再一次性 force 落到 `imgbot`；2026-11-17 三易其稿）                                                                       | 可合并性同原版 rebase 效果；force 目标非空故 PR 只更新不被关闭（实测教训：直落 base 的瞬时空 PR 会被 GitHub **自动关闭**）；PR 文件集由 §7.3 内容重放保证不缩水 |
| D6  | commit 作者身份换为本 App 的 bot 身份（`{app-slug}[bot]`）                                                                                                                                                                                                           | 复用 ImgBotApp 身份既不可能也不合规                                                                                                                             |
| D7  | PR body 页脚链接指向本项目                                                                                                                                                                                                                                           | 品牌归属                                                                                                                                                        |
| D8  | 调度门限用 D1 运行史判断（原版扫 git 历史找 bot commit）                                                                                                                                                                                                             | API 路线下查历史昂贵，D1 更快且等价                                                                                                                             |
| D9  | P3 仪表盘视觉为全新设计；**操作语义与原版 `Web/` 对齐**，按钮/弹窗/状态文案沿用原版逐字（"Request new optimization"、"Settings for …" 等），登录页营销文案与统计面板为新写（原版无统计页）；"Documentation" 链接引用原版 imgbot.net/docs（`.imgbotconfig` 语义兼容） | 原版 Bootstrap+Vue 观感过时；UX 对等 = 操作对等，逐字契约（§2.2）只覆盖 PR/commit 模板                                                                          |

---

## 2. 原版行为规范（UX 契约 = 验收基准）

### 2.1 分支 / PR / commit 行为

| 项             | 规范                                                                     | 原版源码                            |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| 分支名         | `imgbot`，唯一长驻分支                                                   | `Common/KnownGitHubs.cs`            |
| PR 标题        | `[ImgBot] Optimize images`（`prTitle` 可覆盖，付费）                     | 同上                                |
| PR 开启条件    | 有优化结果 **且** 总节省 ≥ `minKBReduced`（KB）                          | `Threshold.cs`                      |
| PR 更新        | 已存在 open PR → 按 head SHA 找到并**原地更新 body**                     | `OpenPrFunction/PullRequest.cs`     |
| commit 标题    | `[ImgBot] Optimize images`                                               | `KnownGitHubs.CommitMessageTitle`   |
| commit 作者    | `ImgBotApp <ImgBotHelp@gmail.com>`（→ D6 换 bot 身份）                   | `KnownGitHubs.cs`                   |
| commit 签名    | PGP 签名 → Verified 徽章（→ §4.3 决策）                                  | `CommitSignature.cs`                |
| 合并检测       | web UI 的 merge / squash 且 ≤2 commits → 删 `heads/imgbot`               | `WebHookFunction.IsDefaultWebMerge` |
| 分支被人类改动 | `imgbot` tip 作者 ≠ bot → 中止，不覆盖                                   | `CompressImages.cs`                 |
| 卡死恢复       | 30 分钟定时器：有 `imgbot` 分支但无 open PR 且分支比上次 PR 新 → 重建 PR | `PrPoisonHandler`                   |
| 并发保护       | 每 installation 串行（`[Singleton("{InstallationId}")]`）                | `OpenPrFunction/OpenPr.cs`          |

### 2.2 文案模板（逐字，验收时 diff 对比）

**commit message**（结构来自 `CompressImagesFunction/CommitMessage.cs`，行格式来自 `CompressionResult.cs`）：

```
[ImgBot] Optimize images

*Total -- 1,234.56kb -> 987.65kb (20%)        ← 仅 >1 张图时出现
                                              ← `*Total` 行后恰好 1 个空行（已对拍上游 `CommitMessageTests`）
*img/logo.png -- 234.56kb -> 123.45kb (47.37%)
*docs/shot.jpg -- 1,000.00kb -> 864.20kb (13.58%)
                                              ← 按 PercentSaved 降序
Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>
```

行格式精确规则（`CompressionResult.ToString()`）：

```
{path(反斜杠→正斜杠)} -- {SizeBefore:N2}kb -> {SizeAfter:N2}kb ({PercentSaved:0.##}%)
```

- `N2` = 千分位 + 2 位小数；`0.##` = 最多 2 位小数、去尾零
- 单位是 **kb**（小写，KB = bytes/1024 的 double）
- `*Total` 行标题即 `*Total`（无路径）；`Parse()` 的回读正则：`\*?(.*) -- (.*)kb -> (.*)kb \((.*)%\)`
- 空行布局：标题后 1 空行；`*Total` 行（若有）后 1 空行；文件行块后 1 空行；`Signed-off-by` 收尾（末尾带换行）
- PR 明细表 Before/After 单元格**含 `kb` 后缀**（`Stats.ParseStats` 保留原文，如 `163.11kb`；已对拍上游 `PullRequestBodyTests`）

**PR body**（`OpenPrFunction/PullRequestBody.cs`，逐字模板）：

```markdown
## Beep boop. Your images are optimized!

Your image file size has been reduced by **20%** 🎉

<details>
<summary>
Details
</summary>

| File          | Before         | After        | Percent reduction |
| :------------ | :------------- | :----------- | :---------------- |
| img/logo.png  | 234.56kb       | 123.45kb     | 47.37%            |
| docs/shot.jpg | 1,000.00kb     | 864.20kb     | 13.58%            |
|               |                |              |                   |
| **Total :**   | **1,234.56kb** | **987.65kb** | **20.00%**        |

</details>

---

[📝 docs](https://imgbot.net/docs) | [:octocat: repo](https://github.com/imgbot/ImgBot) | [🙋🏾 issues](https://github.com/imgbot/ImgBot/issues) | [🏪 marketplace](https://github.com/marketplace/imgbot)

<i>~Imgbot - Part of [Optimole](https://optimole.com/) family</i>
```

精确规则（源自 `ReplacePrMagicTags`）：

- 比例行 = `Your image file size has been reduced ` + （当 `Math.Round(总Percent) >= 5` 时）`by **{Percent:N0}%** ` + `🎉`
  - 不足 5% ⇒ `Your image file size has been reduced 🎉`
- 明细表首行是**单图特例**（只一行、无 Total）；多图时**第 0 条统计是 Total**，逐行从第 1 条打起，末尾空行 + `| **Total :** | ...`（Percent 用 `N2`）
- 无统计时（异常兜底）body = `Beep boop. Optimizing your images is my life. https://imgbot.net/ for more information.`
- `prBody` 覆盖 + magic tags `{optimization_ratio}` `{optimization_details}`（D2：不设付费墙）
- 页脚四链接 + Optimole 落款按 D7 换为本项目身份，**排版结构不变**

### 2.3 `.imgbotconfig` 语义（`Common/RepoConfiguration.cs`）

| 字段                    | 类型                           | 默认     | 语义                                                                                                                                                                                      |
| ----------------------- | ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schedule`              | `"daily"\|"weekly"\|"monthly"` | 关       | 按周期重跑（门限判断见 D8）                                                                                                                                                               |
| `ignoredFiles`          | string[]                       | `[]`     | 原版 `NormalizePattern` 语义（已对拍源码 + 上游 MSTest 向量）：`\`→`/`、`**`→`.*`、前导 `*` 补 `.`；**不转义正则元字符、子串匹配**；正则选项/大小写敏感性照抄原版。实现须逐行为等价（R8） |
| `aggressiveCompression` | bool                           | `false`  | `false` = 仅无损；`true` = 无损+有损                                                                                                                                                      |
| `compressWiki`          | bool                           | `false`  | 同时优化 `<repo>.wiki`，**直接 push 到 wiki 默认分支，不开 PR 无阈值门**（实测：REST Git Data API 不服务 wiki 仓，走 git 协议/isomorphic-git）                                            |
| `minKBReduced`          | int                            | `10`     | 总节省 < 阈值（KB）不开 PR；**≤0 = 无阈值（总是开）**                                                                                                                                     |
| `prTitle`               | string                         | 内置标题 | 覆盖 PR 标题                                                                                                                                                                              |
| `prBody`                | string                         | 内置模板 | 覆盖 PR body（支持 magic tags）                                                                                                                                                           |
| 未知键                  | —                              | 忽略     | 向前兼容；`labels` 原版即存根，不做                                                                                                                                                       |

### 2.4 事件响应矩阵（`WebHook/WebHookFunction.cs` 对照 → 本设计）

| GitHub 事件                                  | 条件                                                           | 动作                                           |
| -------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `installation` / `installation_repositories` | 新增 repo                                                      | 每 repo 入队**全量**优化 run                   |
| `push`                                       | 默认分支，diff 触碰图片扩展名或 `.imgbotconfig`                | 入队增量 run                                   |
| `push`                                       | `imgbot` 分支，作者 = bot                                      | 入队 PR 创建/更新                              |
| `push`                                       | `imgbot` 分支，作者 = 人类                                     | run 中止，记 `aborted_by_human`                |
| `push`                                       | 默认分支，识别为 web 合并 `imgbot`（merge/squash，≤2 commits） | 删 `heads/imgbot`                              |
| `marketplace_purchase`                       | —                                                              | （P3）同步配额                                 |
| cron                                         | 每 30 分钟                                                     | 卡死 PR 巡检                                   |
| cron                                         | 每日                                                           | `schedule` 仓重跑（daily/weekly/monthly 门限） |

> 注：push payload 会截断 commit 列表，**文件集一律从 compare/tree API 推导**，不信任 payload（原版本地枚举文件，等价物是 tree 扫描）。

---

## 3. 总体架构

### 3.1 组件图

```
GitHub App webhook
   │  (HMAC 校验 · delivery 去重 · 202 快速应答)
   ▼
Worker: ingress ──► Queue: router
                       │  (仅描述符消息，≤128KB)
                       ▼
              Workflow: OptimizeRun（每仓一次运行）
                ① init-run          D1 记账
                ② load-config       读 .imgbotconfig
                ③ scan-tree         递归 tree + 忽略规则 + 哈希缓存比对
                ④ optimize-batch    逐块：取 blob→R2→WASM 优化→结果回 R2   ← cpu_ms 5min/步
                ⑤ commit            一次 POST /git/trees（内联全部 blob）
                ⑥ open-pr           创建/更新 PR（模板逐字复刻）
                ⑦ cleanup           R2 TTL 兜底 + run 终态
                       │
   ┌───────────────────┼──────────────────────┐
   ▼                   ▼                      ▼
Durable Object      D1                    R2
(per repo 锁+防抖)  (installations/        (blob 暂存,
                     runs/image_cache/      生命周期 TTL)
                     pulls/deliveries)
   │
   ▼
Cron: 卡死 PR 巡检 · schedule 重跑 ──► Pages(P3): 仪表盘
   │
   ▼（超限路由，P2+）
Containers(beta): sharp/image_optim 处理 ≥8MP/15MB 大图 + GIF 1:1 兜底
```

### 3.2 服务映射表

| 原版（Azure）                                | 本设计（Cloudflare）                                  | 关键限额                                    |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| `WebHookFunction`                            | Worker `ingress`                                      | 128MB 内存；GitHub 要求 ~10s 内应答         |
| `RouterFunction` + 6 队列                    | Queue `router` + **Workflow**                         | 消息 128KB（只传描述符）；步进重试/状态持久 |
| `CompressImagesFunction`（600s/图、750s/仓） | Workflow 步 `optimize-batch`，`limits.cpu_ms: 300000` | 5min CPU/步，**墙钟不限**（强于原版）       |
| `InstallationTokenProvider`                  | WebCrypto RS256 + DO/KV token 缓存                    | token TTL 1h，提前 5min 轮换                |
| LibGit2Sharp clone/commit/push               | Git Data API（§4.2）                                  | 内容写入二级限速 80/min、500/hr             |
| `[Singleton(installationId)]`                | Durable Object `repo:{installation}/{repo}`           | 单线程天然串行                              |
| Azure Tables ×4                              | D1                                                    | 10GB/库；查询/次 1,000                      |
| `$TMP` 目录                                  | R2                                                    | 5TiB/对象，无出流量费                       |
| `PrPoisonHandler` / `DeleteBranchFunction`   | Cron + Workflow 步                                    | cron 墙钟 15min                             |
| `MarketplaceSyncFunction`                    | （P3）cron                                            | —                                           |
| `Web/` Vue 仪表盘                            | Pages + GitHub OAuth                                  | P3                                          |
| ImageMagick/mozjpeg/gifsicle/svgo 原生二进制 | WASM/JS 编解码（§6）                                  | 内存 128MB 是硬顶                           |

---

## 4. GitHub 集成层

### 4.1 认证

1. **App JWT（RS256）**：`crypto.subtle.importKey("pkcs8", der, {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"}, …)` → sign → base64url。claims：`iat=now-60`、`exp=now+600`、`iss=appId`。PEM 解析注意 `\n` 转义还原。GitHub 后台下载的 PEM 是 PKCS#1（`BEGIN RSA PRIVATE KEY`），`pemToPkcs8Der` 自动包成 PKCS#8；加密 PEM 明确不支持。
   - 或直接用 `universal-github-app-jwt` v2 / `@octokit/auth-app`（已验证可在 workerd 运行；token cache 传 DO/KV 实现）。
2. **installation token**：`POST /app/installations/{id}/access_tokens`，TTL 1h；DO 内缓存并提前 5min 轮换。不落盘持久化。
3. **webhook HMAC**：对**原始字节**做 `HMAC-SHA256`（先 `arrayBuffer()` 再 parse，重序列化会毁摘要），`crypto.subtle.verify`；失败 401。
4. **去重**：`x-github-delivery` 入 `deliveries` 表（唯一索引），重复投递直接 202 丢弃。

### 4.2 仓库读写（替代 git clone）

读：

- `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` → 全量 `blob` 条目（注意 `truncated` 标志，超大仓退化为分目录递归）
- `GET /git/blobs/{sha}` + `Accept: application/vnd.github.raw` → 原始字节（>1MB 必须走此端点）

写路径（**R1 定案 = §4.3 方案 A**：GraphQL `createCommitOnBranch`，一次调用完成 blob 入库 + commit + 分支推进，**GitHub 自动 PGP 签名 → Verified 徽章**，实测二进制 base64 逐字节保真）：

1. 前置：`imgbot` 分支归位 base 头（`ensureRef` 首建 / `updateRef force`，D5）
2. `GraphQL createCommitOnBranch`（`fileChanges.additions: [{path, contents: base64}]`，`expectedHeadOid` = base 头）——`contents` 强制 Base64（文本/二进制同规）
3. `POST /pulls` 或 `PATCH /pulls/{n}`（原地更新 body）

> 历史注记：早期方案是 `createTree` 内联 content（二进制不安全）→ 逐图 `POST /git/blobs` + tree 引用（N+4 次写调用）；GraphQL 方案把这些全部收敛为 **1 次内容调用**。唯一残留风险：超大 PR 的单请求体体积（~15MB 级实测未触顶，极限待观测）。

### 4.3 提交签名与 Verified 徽章（P1 决策门）

| 方案                                  | Verified                                      | 二进制大文件                                     | 成本/风险                | 结论                                  |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------ | ------------------------ | ------------------------------------- |
| A. GraphQL `createCommitOnBranch`     | 文档承诺 GitHub 自动签名（社区有个案未生效）  | `FileAddition.contents` 对二进制的支持**须实测** | 1 次调用一个 commit      | **首选，P1 第一周实测**               |
| B. REST tree/commit + openpgp.js 自签 | 复刻原版 PGP（注册公钥到 App 账号）           | 无限制                                           | openpgp.js 内存/耗时偏高 | A 不行时的保底                        |
| C. REST 不签名                        | 无徽章；"Require signed commits" 规则下会被拒 | 无限制                                           | 零成本                   | 仅当 A/B 都不可行（不满足"相同体验"） |

**定案（2026-11-17）：A**。真仓探针 + 真实流水线双重实测：`verified: true, reason: "valid"`（GitHub 亲签 PGP，committer=GitHub、author=`{app}[bot]`）；`FileAddition.contents` 强制 Base64、二进制逐字节保真（60KB PNG 实测）；文本与二进制同规。B 保留为备胎（openpgp.js + 密钥管理），C 否决。

---

## 5. 编排与状态机

### 5.1 Run 状态机

```
queued → scanning → optimizing → committing → pr_open
   │          │           │            │           └─(合并后)→ merged_cleanup → done
   │          │           │            └─(不足阈值)→ skipped_threshold → done
   │          │           └─(无优化结果)→ skipped_nochange → done
   │          └─(人类改过 imgbot)→ aborted_by_human
   └─(守卫失败: archived/empty/无权限)→ skipped_guard
任意态 ─(不可恢复错误)→ failed（进 DLQ + 巡检可见）
```

### 5.2 消息契约（Queue `router`，描述符模式）

```json
{
  "run_id": "01J…",
  "installation_id": 123456,
  "repo": "owner/name",
  "trigger": "installation | push | schedule | manual | recovery",
  "base_ref": "main",
  "base_sha": "abc…",
  "delivery_id": "uuid（可选，用于溯源）"
}
```

- 图片字节**永不进消息**（128KB 限制）；需要回放的原始 payload 存 R2 `payloads/{delivery_id}`。
- 重复投递幂等：`run_id` 在 D1 唯一，Workflow instance id = `run_id`，已存在即跳过。

### 5.3 Workflow `OptimizeRun` 步骤（步名确定性，勿用时间戳）

| 步                       | 内容                                                                                                                                                                                                                | 重试 | 超时                   | 注意                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------- | ------------------------------------------------------ |
| `init-run`               | D1 建 run 行、DO 抢锁（抢不到→防抖合并进现有 run）                                                                                                                                                                  | 3    | 30s                    | 幂等：`run_id` 已存在则直接成功                        |
| `load-config`            | 取 `.imgbotconfig` blob 并解析（§2.3）                                                                                                                                                                              | 3    | 1min                   | 无文件 = 全默认                                        |
| `scan-tree`              | 递归 tree → 过滤扩展名/忽略规则 → 与 `image_cache` 比对 → 待优化清单                                                                                                                                                | 3    | 5min                   | 输出 R2 key 清单（**步返回 ≤1MiB**，大清单分页为多步） |
| `optimize-batch-{chunk}` | 每块 ≤10 图：取 blob→R2→按格式派发编解码→仅保留变小者→**结果入 R2（`.opt`）+ 记统计**（不再逐图建 blob，入库收敛到 commit 步）                                                                                      | 2    | 10min，`cpu_ms:300000` | 并发=1；块内逐图 try/catch；>8MP/15MB 路由 §6.3        |
| `commit`                 | 人类守卫（tip 非 bot → `aborted_by_human`）→ 暂存分支重建 commit（D5 终稿）→ **GraphQL `createCommitOnBranch`（GitHub 自动 PGP 签名，§4.3-A）**→ imgbot 一次性 force 落位；步首过 `minKBReduced` 阈值门（全量口径） | 3    | 5min                   | 失败重试需幂等（先查 ref 当前 sha 是否已是产物）       |
| `open-pr`                | 阈值判断 → 创建/更新 PR（模板 §2.2）→ D1 记 `pulls`                                                                                                                                                                 | 3    | 5min                   | 与 `commit` 同为幂等关键路径                           |
| `cleanup`                | R2 清暂存（TTL 双保险）、run 终态、释锁                                                                                                                                                                             | 3    | 1min                   | —                                                      |

> 块大小 10 图、每步 5min CPU：按实测 ~130ms/MP（有损 JPEG）/ ~50-300ms/MP（PNG），一块 ≈ 数秒 CPU，余量充足；巨仓 = 多块，墙钟不限。

### 5.4 Durable Object：`RepoLock`

- id：`repo:{installation_id}/{repo}`
- **唯一入口漏斗**：Queue 消费者不直接建 Workflow 实例，统一调 `submit(desc)`——锁空闲 → 建实例（`env.OPTIMIZE.create`）并持锁；锁占用 → 记为 pending（push 防抖：后来者覆盖，最多 1 份），返回 coalesced
- `finish(run_id)`：释放锁并启动 pending（若有）；`heartbeat(run_id)`：优化步内续租
- 租约 alarm（默认 60min）兜底僵死 run：超时按 finish 处理
- 实现要点：RPC 方法（勿用旧 `fetch` 模式）；一切状态落 DO storage，不用模块级变量；实例创建幂等（同 id 已存在按已启动处理）

---

## 6. 优化引擎

### 6.1 格式 × 模式 × codec

| 格式               | 无损（默认）                                                                                                           | 有损（aggressive）                                                    | 许可                     | 实测/估算成本                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| `.svg`             | **svgo**（纯 JS，无 wasm）                                                                                             | 同（svgo multipass）                                                  | MIT                      | 毫秒级，中位 ~42% 削减                                          |
| `.jpg/.jpeg`       | mozjpeg `jpegtran -optimize -copy none` → wasm（**需自行编译打包**）                                                   | `@jsquash/jpeg`（mozjpeg 编码器，q80）                                | IJG/BSD、Apache-2.0      | 有损 dec 12ms/MP + enc 117ms/MP ≈ **130ms/MP**（实测 3MP 样张） |
| `.png`             | **oxipng**（MIT，Rust→wasm，`@jsquash/oxipng`）+ chunk 剥离，双候选取小（2026-11-17 接入）                             | pngquant/libimagequant wasm（**GPL-3**，见开放问题）或 `@jsquash/png` | MIT / GPL-3 / Apache-2.0 | 无损 50–300ms/MP；pngquant 50–150ms/MP                          |
| `.gif`             | **omggif 解码 + gifenc 重编码**（纯 JS、MIT×2；保色调色板 → 像素无损；2026-11-17 定稿，取代 gifsicle-wasm/GPL-2 路线） | `quantize` 128 色量化 + 与无损候选取小                                | MIT×2                    | 实测：注释型 783B→141B；aggressive −25%；400×400 ≈33ms          |
| 大图 ≥8MP 或 ≥15MB | → §6.3 Containers                                                                                                      | 同                                                                    | —                        | —                                                               |

契约不变式（与原版一致）：**只有严格变小的文件才替换**；优化后所有非 SVG 图**解码验证**一次（原版用 ImageMagick reset 校验防损坏），校验失败即丢弃该文件结果。

实测记录（bench 夹具）：`shot.png` chunk 剥离 60,121→59,971B，而 `@jsquash/png` 重编码 86,913B（更大，被弃）——PNG 无损主力应为 **oxipng-wasm（提前到 P1.5）**，`@jsquash/png` 仅兜底；JPEG P1 段剥离不含 Huffman 重优化（`-optimize`），节省来自元数据；CMYK/YCCK 图需保留 APP14（见 `src/optimize/jpeg.ts` 注释）。
PNG 有损（b 路线，2026-11-17 落地）：gifenc `quantize`（MIT）调色板量化 → jsquash 编码（lodepng 自动落索引色）。实测：65k 色渐变 314,781→**41,502B（−86.8%）**；透明槽保留；低色图无收益（契约兜底）。c/d 路线（容器 sharp palette）已并存于 §6.3 通道。

### 6.2 打包与运行约束（硬性）

1. **禁止运行时编译 wasm**：`WebAssembly.compile` / `compileStreaming` / `instantiate(bytes)` / `instantiateStreaming` 在 workerd 全部禁用 → 编解码器必须**构建期 import**（wrangler 打包为 `WebAssembly.Module`），`@jsquash` 用 `init(WebAssembly.Module)` 注入（绕开其默认 fetch 加载器）。全部 codec 合计 ~10MB，64MiB bundle 上限无压力。
2. **128MB 内存/隔离是真正的墙**（解码 RGBA 4B/px + 编码缓冲 ≈ 3× 峰值）：单图 >8MP（≈96MB）或 >15MB 直接走 §6.3 或跳过；`optimize-batch` 块内**并发=1**。
3. 单线程：无 Web Worker/threads，SIMD 可用（`@jsquash/webp` 用 simd 版）。

### 6.3 Containers 兜底（✅ 已落地，2026-11-17）

> 实测：3 张 >8MP 截图经容器 optipng 救回（−29.6% / −35.2% / −34.8%，PR#5）；
> 传输偏差：`POST /optimize` 直传 base64 字节（非 R2 key）——容器无状态、无 R2 绑定，≤50MB 图在 Worker 100MB 上限内。
> 客户端必须 `startAndWaitForPorts()` 后再 fetch（否则冷启动 connection refused，实测教训）。

- 触发条件：像素 >8MP 或 文件 >15MB，或 GIF 有损（若 wasm 补丁未就绪）
- 形态：`@cloudflare/containers` 容器（standard-1 起：0.5 vCPU / 4GiB），内跑 sharp / image_optim / gifsicle 原生二进制；Worker 经 DO `getByName(run_id)` 调用，HTTP 传 R2 key（不传字节流经 DO）
- 生命周期注意：`sleepAfter` 以请求活动计时，长任务需 keepalive 触碰 storage；`startAndWaitForPorts()` 后再发请求
- 可运行样板：`ccbikai/cloudflare-worker-image`（Worker+Container 图像服务已上线：`wrangler.jsonc` containers 配置、`getRandom` 路由、`onError` 降级、两段式 Rust Dockerfile 可直接对照；注意其编码器是通用 `image` crate，属"处理"非"优化"，压缩器仍按 §6.1 选型）

### 6.4 完整性校验

- 每张优化结果（非 SVG）重新解码一次，失败 → 丢弃该结果（保持原文件）
- 与原版一致的语义：宁可少优化，不可损坏
- P1 起就做（wasm 解码器已在包内，成本≈0）

---

## 7. 存储模型

### 7.1 D1 schema

```sql
CREATE TABLE installations (
  installation_id INTEGER PRIMARY KEY,
  account_login   TEXT NOT NULL,
  account_type    TEXT,                  -- User | Organization
  plan_id         INTEGER,               -- P3 前恒 NULL
  created_at      TEXT NOT NULL
);

CREATE TABLE repos (
  installation_id     INTEGER NOT NULL,
  name                TEXT NOT NULL,     -- owner/repo
  default_branch      TEXT,
  default_branch_override TEXT,          -- 原版 settings.DefaultBranchOverride
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_run_at         TEXT,
  PRIMARY KEY (installation_id, name)
);

CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,      -- = Workflow instance id
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  trigger         TEXT NOT NULL,         -- installation|push|schedule|manual|recovery
  state           TEXT NOT NULL,         -- §5.1 状态机
  base_sha        TEXT,
  commit_sha      TEXT,
  pr_number       INTEGER,
  images_total    INTEGER,
  images_optimized INTEGER,
  bytes_before    INTEGER,
  bytes_after     INTEGER,
  min_kb_reduced  INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL,
  finished_at     TEXT
);
CREATE INDEX idx_runs_repo ON runs(repo, created_at DESC);

CREATE TABLE image_cache (               -- 防重复优化的哈希缓存
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  path            TEXT NOT NULL,
  source_hash     TEXT NOT NULL,         -- 原 blob sha256
  result_hash     TEXT,
  source_size     INTEGER,
  result_size     INTEGER,
  optimized_at    TEXT,
  PRIMARY KEY (installation_id, repo, path, source_hash)
);

CREATE TABLE deliveries (                -- webhook 去重
  delivery_id TEXT PRIMARY KEY,
  event       TEXT,
  received_at TEXT NOT NULL
);

CREATE TABLE pulls (
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  head_sha        TEXT,
  state           TEXT,                  -- open|closed|merged
  opened_at       TEXT, closed_at        TEXT,
  PRIMARY KEY (installation_id, repo, pr_number)
);

CREATE TABLE settings (                  -- 仪表盘/手动覆盖项（分支覆盖等）
  installation_id INTEGER NOT NULL,
  repo            TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT,
  PRIMARY KEY (installation_id, repo, key)
);
```

### 7.2 R2

| key 模式                   | 内容                                 | 生命周期                                      |
| -------------------------- | ------------------------------------ | --------------------------------------------- |
| `staging/{run_id}/{path}`  | 待优化/已优化字节                    | TTL 1 天（`cleanup` 步主动删 + 生命周期兜底） |
| `payloads/{delivery_id}`   | 原始 webhook payload（可选，回放用） | TTL 7 天                                      |
| `oversize/{run_id}/{path}` | 走 Containers 的大图中转             | TTL 1 天                                      |

### 7.3 优化哈希缓存语义

- `scan-tree` 对每个候选 blob：`source_hash`（= blob sha）命中 `image_cache` ⇒ 跳过。**正负向两级**（2026-11-17）：`result_hash` 非空 = 已优化且已提交 → 统计进重放（PR body/commit message 的全量口径）；`result_hash` 为空 = 已判定 `not_smaller`/`decode_failed` → 直接跳过（免每轮重试，实测省 ~4 分钟/轮）。`unsupported`/`too_large` 不缓存（格式支持会演进）
- **正向行在 commit 成功后才回填**：阈值门可能整轮放弃提交，提前入缓存会让统计重放虚报"已在 PR 里"
- 分支重建（D5）不破坏缓存：缓存键是 `(repo, path, source_hash)`，与分支拓扑无关
- 用户手动改回某图 → blob sha 变化 → 自然重新优化（与原版行为一致）

---

## 8. 限额与预算

| 资源             | 每次运行预算         | 上限                     | 结论                                                                                   |
| ---------------- | -------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Workflow 步数    | 7 + ⌈N/10⌉           | 1,024 free / 10,000 paid | 万图内无压力                                                                           |
| 步返回体积       | 仅 R2 key + 统计     | 1MiB/步                  | 清单分页                                                                               |
| Workflow 并发    | —                    | 25 free / 10k paid       | —                                                                                      |
| CPU/步           | 优化块最重           | 5min（`limits.cpu_ms`）  | 墙钟不限                                                                               |
| 隔离内存         | 单图峰值 ~3×像素字节 | 128MB                    | 8MP/15MB 守卫                                                                          |
| GitHub API       | ~N+10 调用           | 5,000/hr/installation    | 内容写入 1 次（GraphQL `createCommitOnBranch` 内联全量 base64）；PR 总字节量是唯一约束 |
| 内容写入二级限速 | ~4                   | 80/min、500/hr           | 内联 tree 已规避                                                                       |
| Queue 消息       | 1 条/运行            | 128KB                    | 只传描述符                                                                             |
| R2               | N 图暂存             | 5TiB/对象                | TTL 清理                                                                               |

平台成本：Workers Paid（$5/月，含 10M req + 30M CPU-ms，超量 $0.02/CPU-ms 百万）+ D1/R2/Queues 免费额度 → 典型个人/中型用量**月成本个位数美元**；对比原版 Azure Functions 长驻容器显著更低。

---

## 9. 风险登记册

| #   | 风险                                                                                                                                                                                                      | 影响                     | 缓解                                                                       | 验证                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- | ------------------------------------ |
| R1  | `createCommitOnBranch` 的 Verified 徽章未按文档生效；`FileAddition` 二进制支持存疑                                                                                                                        | 体验差一档 / 阻塞        | §4.3 A→B→C 降级链                                                          | P1 第一周真仓实测                    |
| R2  | 内容写入二级限速（80/min、500/hr）                                                                                                                                                                        | 巨仓 PR 慢               | blob 写入分散到各 chunk 步（≤10/步）+ 步进重试退避消化 429；巨仓分批/分 PR | 用 2000 图夹具仓压测                 |
| R3  | ~~GIF 无现成 workerd 编码路径~~ **已关闭（2026-11-17）**：omggif+gifenc 纯 JS 落地（`src/optimize/gif.ts`）                                                                                               | ~~功能缺口~~             | 与原版 gifsicle 的差距记 §9-R6；gifsicle 级优化归 Containers 线            | 9 条单测 + 真仓 12 张 GIF 验证       |
| R4  | ~~大图 OOM（128MB）~~ **已关闭（2026-11-17）**：守卫 + Containers 兜底双保险，3 张真仓巨图实测救回（−29.6%/−35.2%/−34.8%）                                                                                | ~~run 失败~~             | 尺寸守卫 + 容器通道 + 逐图 try/catch 隔离                                  | 15MP 夹具 + 真仓实测                 |
| R5  | `compressWiki`：wiki 仓对 Git Data API 支持未知                                                                                                                                                           | 功能缺口                 | 实测；备选 isomorphic-git（官方支持 Workers）                              | P2 实测 `owner/repo.wiki`            |
| R6  | wasm 编解码与原版二进制压缩率不完全一致                                                                                                                                                                   | 数字略有出入（契约不变） | 明示"变小才替换"；基准回归集对比                                           | 建 20 图基准集记录前后对比           |
| R7  | ~~GPL 编解码（gifsicle GPL-2、libimagequant GPL-3）传染性~~ **已定案（2026-11-17）**：Worker bundle 零 copyleft（gifenc/omggif（MIT）顶替、pngquant 不采用）；gifsicle 仅容器独立进程（mere aggregation） | ~~开源合规~~             | LICENSES.md §3 决策记录 + THIRD_PARTY_NOTICES.md                           | 发布前清单大部完成（LICENSES.md §4） |
| R8  | `ignoredFiles` glob→regex 等价性                                                                                                                                                                          | 配置行为不一致           | 用原版 `Test/` 夹具移植测试向量                                            | 单测对拍                             |
| R9  | webhook 投递重复/乱序                                                                                                                                                                                     | 重复 PR                  | `deliveries` 去重 + run 幂等 + DO 锁                                       | 混沌用例：双投递、乱序 push          |
| R10 | 巨型 mono-repo tree `truncated`                                                                                                                                                                           | 扫描不全                 | 检测 truncated → 分目录递归                                                | 夹具仓模拟                           |

---

## 10. 分期计划与 DoD

### P1 — MVP（核心体验 ≈95%）

范围：ingress（HMAC+去重）→ run 编排（Workflow + DO 锁）→ 无损优化 **SVG/PNG/JPG** → 阈值 → commit → PR 开启；`.imgbotconfig` 的 `ignoredFiles`/`minKBReduced`；模板逐字复刻。

DoD：

1. 真实仓库端到端：push 图片 → 数分钟内出现 `imgbot` 分支 + `[ImgBot] Optimize images` PR，body/commit 与 §2.2 模板 diff 逐字一致
2. Verified 徽章决策落地（R1 关闭）
3. 20 图基准集：压缩率与原版差距记录在案
4. 幂等/防抖混沌用例通过（重复 webhook、连环 push）
5. 15MP 大图不炸 run（守卫生效）

### P2 — 功能全量

范围：有损模式、GIF（含补丁）、`schedule`、`compressWiki`、`prTitle/prBody` + magic tags、PR 原地更新、合并删分支、人类改动中止、30 分钟巡检、Containers 兜底。

DoD：§1.1 清单除仪表盘/计费外全部勾掉；R3/R5 关闭。

### P3 — 产品层

范围：Pages 仪表盘（OAuth、repo 开关、手动触发、分支覆盖、统计）、GitHub Marketplace/配额（可选）。

DoD：仪表盘操作与原版 `Web/` 行为对齐；多租户限额生效。

**状态（2026-11-17）**：仪表盘已落地（`public/` SPA + `src/dashboard/` OAuth/REST，操作对齐原版、文案见 D9）；GitHub Marketplace/配额（可选）未做——按 D2/D3 全员无付费墙，`prTitle`/`prBody` 全功能开放，多租户限额延后至引入计费层时再议。

---

## 11. 开放问题（动手前需实测）

1. ✅ **已定案并落地（2026-11-17）**：走 §4.3 方案 A（GraphQL `createCommitOnBranch`），真实流水线 commit `f8e5ac7` 实测 `verified: true`（GitHub PGP 签名）。二进制 base64 保真、文本同规均已实测；备胎 B（openpgp.js）封存
2. ✅ **已实测（2026-11-17）**：REST Git Data API **不服务** wiki 仓（`github/gitignore.wiki` 等三个有内容的公共 wiki 全部 404，判别性实验）→ R5 走 **git 协议**（isomorphic-git，官方支持 Workers），wiki 模式 = clone→优化→直接 push 默认分支
3. `@jsquash` 各 codec 在 workerd 实测 CPU/内存（本地基准是 Node V8，同引擎但需真环境确认 8MP 边界值）；并实测 workerd 是否提供全局 `ImageData`（jsquash 解码内部 `new ImageData`，缺则在 codec init 补 ~5 行 shim；类型已用 `ImageDataLike` 解耦）
4. ~~oxipng/jpegtran 的 wasm 构建产物体积与 SIMD 支持~~ **oxipng 半闭环（2026-11-17）**：`@jsquash/oxipng` 2.3.0 ST wasm 实测 **164KB**（MT 版 232KB 不适用——workerd 无线程，已钉 ST pkg），无 SIMD 依赖；**jpegtran 侧仍开放**（`@chimok/jpegtran-js` 仅几何变换不含 `-optimize`，见任务 2）
5. ~~GPL 编解码的许可策略（R7）~~ **已定案（2026-11-17）**：bundle 零 copyleft，gifsicle 仅容器独立进程——见 LICENSES.md §3 与 §9-R7
6. ✅ ~~`ignoredFiles` 正则等价性测试向量~~ 已对拍：上游 `RepoConfiguration` MSTest 向量已移植进 `tests/config.test.ts`
7. ✅ **已闭环（2026-11-17）**：`@jsquash/png` 重编码比原文件更大的问题由 **oxipng 候选**解决——PNG 无损 = chunk 剥离 + oxipng 双候选取小（`src/optimize/png.ts` `createOxipngOptimizer`，tests/png-oxipng.test.ts 五条契约用例；bench 语料 PNG 实测 0%→37–92%）

## 12. 附录：调研来源

- 原版行为：`imgbot/Imgbot` 源码（`WebHook/` `CompressImagesFunction/` `OpenPrFunction/` `Common/` `Docs/`），本文引用的逐字模板出自 `PullRequestBody.cs`、`CommitMessage.cs`、`CompressionResult.cs`
- Workers/Queues/Workflows/Containers 限额：developers.cloudflare.com 对应 platform/limits 页
- WASM 运行时限制（禁 compile/instantiate(bytes)）：developers.cloudflare.com/workers/runtime-apis/webassembly
- 编解码可行性与实测基准：`bench/bench.mjs`（@jsquash mozjpeg/png/webp，3MP 样张 median-of-3；`cd bench && npm i && node bench.mjs` 可复现）；`node-libraries/wasm-image-optimization`（专为 workerd 提供入口）
- GitHub App on Workers 先例：`biw/cloudflare-github-actions-runner`、`cloudflarebase/cloudflarebase`、`universal-github-app-jwt` v2
- Workers+Containers 图像服务样板：`ccbikai/cloudflare-worker-image`（其 `v1` 分支为纯 Worker + jSquash，可作 P1 wasm 路线的生产对照）
- isomorphic-git on Workers（备选路径）：isomorphic-git.org/docs/guide-cloudflare-workers

---

## 13. P3 仪表盘技术设计（2026-11-17 评审通过）

### 13.1 总体形态与部署拓扑

| 决策                                                          | 备选                                                                                | 选择理由                                                                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **静态 SPA + 同域 Worker API**（单 `wrangler deploy` 出一切） | a) 原版式分离 auth 域（`auth.imgbot.net`）；b) Pages + Pages Functions；c) SSR 框架 | 同域 → cookie 天然同源，无跨域 CORS/credentials，少一个部署单元、少一对密钥。`wrangler.jsonc` 的 `assets.run_worker_first: ["/api/*","/healthz"]` + `not_found_handling: "single-page-application"` 承担分流 |
| **vanilla JS 单文件 SPA，零构建零依赖**                       | Vue（原版）、React、Preact+htm、Svelte                                              | 交互面窄（列表+表单+弹窗），框架 = 构建链 + 依赖维护，与"workerd 直跑"的仓库风格一致；代价见 §13.7                                                                                                           |
| 全量重渲染（`replaceChildren` + 重建 DOM）                    | 细粒度响应式                                                                        | 状态对象小、仓库数有限，全量重渲染 <1ms，换取无虚拟 DOM 的状态一致性                                                                                                                                         |

### 13.2 认证与会话（`src/dashboard/auth.ts`）

```
浏览器 → GET /api/auth/login → 302 github.com/authorize（state cookie：HttpOnly/Secure/SameSite=Lax，30min，Path=/api/auth）
      → GET /api/auth/callback?code&state → 对 state → code 换 user token
      → D1 sessions 插行（user_login/user_id/user_token/expires_at）→ Set-Cookie ib_session（随机 256-bit id，7 天，Path=/）→ 302 /
```

- **cookie 只带 session_id，GitHub user token 只存服务端 D1**；HttpOnly + Secure + SameSite=Lax 三件套。
- **CSRF 双保险**：OAuth `state`（单次、绑定 cookie、30min）；logout 只收 POST（tests/auth.test.ts 锁定）。
- 会话过期即查即删（惰性清理）；`idx_sessions_expires` 留给将来定时清扫。
- 弃用 JWT 自包含会话：无法服务端吊销，且 token 依旧要存，不划算。

### 13.3 API 契约与授权（`src/dashboard/api.ts`，5 端点）

```
GET  /api/me                            → {login, userId, installUrl}
GET  /api/repos                         → ReposApiEntry[]（GitHub 可见仓 × D1 聚合）
POST /api/repos/{o}/{r}/optimize        → 202 {runId, started, coalesced}   ← 手动触发入口
POST /api/repos/{o}/{r}/settings        → {enabled?, defaultBranchOverride?}
GET  /api/repos/{o}/{r}/stats           → {totals, recentRuns[], pulls[]}
```

- 授权主体：**用户 token 判可见性**；写操作只投递 RunDescriptor，流水线用 installation token 执行——最小权限分离（§4.1）。
- 触发 = `REPO_LOCK.submit()`，复用 DO 合并语义：并发返回 `coalesced:true`，前端如实呈现"已在进行中"。
- 错误体统一 `{"error":"..."}`（401/403/400/502/500）。
- 列表聚合：每 installation 4 条 D1 查询（runs/pulls/repos.enabled/settings），与仓库数无关；GitHub 侧 `Link` 翻页（10 页 × 100）。

### 13.4 前端架构（`public/`）

- 状态机 `loading → loggedOut | error | ready`；单 state + Map 三件套（`branchDrafts` 草稿 / `repoNotices` 反馈 / `stats` 懒加载缓存）。
- 写操作悲观更新（成功才落 state），进行中禁用控件；失败行内可重试，不打断全局。
- 统计面板首次展开才拉 stats（懒加载 + 缓存）；PR 链 `/{owner}/{repo}/pull/{n}`。
- 可访问性：aria-label/expanded/pressed、`dialog.showModal()`、`prefers-color-scheme`。
- XSS 面：全程 `textContent`，零 `innerHTML`。

### 13.5 数据模型

- `sessions` 表（P3 前次提交）；repo 开关 → `repos.enabled` UPSERT；分支覆盖 → `settings.default_branch_override` UPSERT（NULL=清除）。
- **schema 漂移**：`repos.default_branch_override` 列为历史遗留、未使用，`settings` 表是唯一权威——待清理（§13.7）。

### 13.6 与原版对照（偏差 = D9）

| 维度      | 原版 `Web/`                    | 本实现                                    | 性质           |
| --------- | ------------------------------ | ----------------------------------------- | -------------- |
| 框架/观感 | Vue 2 + Bootstrap              | vanilla + 自研编辑风主题                  | 偏差（有意）   |
| auth 域   | `auth.imgbot.net` 跨域 + axios | 同域 HttpOnly cookie                      | 等价且更简     |
| 操作面    | 装/退、请求优化、分支覆盖      | 同左 + 统计面板（原版无）                 | 超集           |
| 操作文案  | —                              | 逐字沿用（"Request new optimization" 等） | 对齐           |
| 轮询      | 30s 轮询 lastchecked           | 操作后即时刷新                            | 简化（可接受） |
| 计费墙    | Marketplace planId 门控私有仓  | 无（D2/D3）                               | 偏差（登记）   |

### 13.7 已知弱点与待办

1. **前端零自动化测试**（仅 `node --check` + 手动）——最大弱点；补法方向：playwright 级 e2e（mock API 层）。
2. `repos.default_branch_override` 死列清理（schema 迁移）。
3. user token 在 D1 明文（平台静态加密）；如需应用层加密加 AES-GCM 即可，当前判定不必要。
