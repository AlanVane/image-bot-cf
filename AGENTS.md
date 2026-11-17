# AGENTS.md

Imgbot（GitHub 图片优化机器人）在 Cloudflare 上的完整重建：GitHub App → webhook → 优化图片 → 开 PR，UX 与原版逐字对等。

**Spec**（设计与偏差登记、实测考据）：`DESIGN.md` —— 改动管道语义前、实现与文档冲突时、需要架构决策依据时读它；你发现的设计偏差也写回它。

## 校验与部署

```bash
npm run typecheck && npm test     # 完成判据：两者零错（329 tests）
npx wrangler deploy               # 同时构建 container/ 的 Docker 镜像（首次较慢）
```

- GitHub App 本地凭据在 `.dev.vars`（照 `.dev.vars.example` 填；PKCS#1 原样粘贴即可）。远端 secrets 用 `npx wrangler secret put`。
- 部署后立刻触发的 run 会踩**旧版本**（Workflow 实例在创建时钉住版本）：等 ~1 分钟再触发，或直接重触发一次。

## 真仓验证（e2e 仪式）

推送一个带随机标记的 `.imgbotconfig` 变更即触发 run（**空 diff 提交会被正确过滤**，这是幂等设计，不是 bug）：

```bash
node /tmp/opencode/trigger-real.mjs   # 或项目内等价脚本
```

| 观察点                        | 命令                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| run 终态                      | `wrangler d1 execute image-bot-db --remote --command "SELECT state, images_optimized, pr_number, error FROM runs ORDER BY created_at DESC LIMIT 1"` |
| 步级输出（跳过原因/优化明细） | `wrangler workflows instances describe optimize-run <run_id>`（JSON 为转义串，grep 用 `reason[^,}]*` 之类宽容模式）                                 |
| 文案/徽章                     | PR body 与 commit 的 `verification` 字段（REST 提交无徽章属正常——见 §4.3，徽章走 GraphQL 通道）                                                     |

## 硬护栏

- **git**：提交走 `feat/*` 分支（main 禁直提）；推送禁 master/main——wiki 仓初始化例外，由用户手动执行。
- **契约**：任何优化产物必须"严格变小 + 再解码通过"才替换（`dispatch.ts` 统一裁决）；codec 只产候选。
- **二进制写入 git**：走 GraphQL `createCommitOnBranch`（base64 contents）或 blobs 端点；`createTree` 内联 content 只适合文本。

## 坑（每条都踩过）

### workerd 运行时

- wasm 只能**构建期 import** 成 `WebAssembly.Module` 注入；运行时 `WebAssembly.compile`/`instantiate(bytes)` 全被禁。
- 调用原生 `fetch` 用**裸调用或箭头包装**——成员调用（`this.fetchImpl(...)`）触发 WebIDL `Illegal invocation`。
- 内存墙 128MB：>8MP/15MB 图在 `dispatch` 守卫处路由 `optimizeViaContainer`（容器通道）。
- `DurableObject` 从 `cloudflare:workers` 继承；解码中间产物用 `ImageDataLike`（workers-types 无 DOM 的 `ImageData`）。

### GitHub API

- 仓库资源用 **installation token**；App JWT 只够 `/app/*` 系端点。例外：`GET /repos/{o}/{r}/installation`（查 installation 归属）是 **App 视角**端点，只认 JWT/安装 token——用户 token 会被拒（2026-11-17 仪表盘真仓踩坑）；"这个用户能否看到该仓"用用户 token 查 `GET /repos/{o}/{r}`，两个主体各查各的。
- PR/ref API 只认**裸分支名**（`imgbot`）——`ensureRef` 的 `heads/imgbot` 形式透传过去就是 422。
- **force-push 让 PR 瞬间变空会触发 GitHub 自动关闭**——commit 走暂存分支中转（D5）：commit 落 `imgbot-staging`，再一次性 force 落 `imgbot`。
- **REST Git Data API 不服务 `.wiki` 仓**（判别实验见 DESIGN §11）——wiki 走 `wiki-git.ts`（isomorphic-git，需 `nodejs_compat`）。
- GitHub App 的 webhook 里 `installation`/`installation_repositories` 无订阅选项（自动投递）；Recent Deliveries 不显示 = webhook 未激活。

### 编码器选型（详见 DESIGN §6）

- PNG 有损用 gifenc `quantize`（MIT）；`wasm-image-optimization` 的 PNG quality 是 no-op（实测）。
- GIF 用 omggif+gifenc（纯 JS）；gifsicle 是 GPL-2，只出现在容器进程里。
- 已知与原版 gifsicle/mozjpeg 的压缩率数字差：契约不变，数字不锚定（§9-R6）。
