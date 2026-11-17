# 第三方组件许可证与合规清单

> 范围：随 Cloudflare Worker bundle 一起分发（编译进 `dist/`）的代码与 wasm，以及 P2/P1.5
> 计划引入的编解码器。对应 DESIGN.md §6.1（格式 × 模式 × codec）与 §9-R7（GPL 传染性）。
>
> 最近核对：2026-11-17（依据 `package-lock.json` 与 `node_modules` 内的 LICENSE 文件）。
> 依赖或 bundle 变化时须重新生成此表。

## 1. 当前 bundle 内组件（P1）

| 组件                                     | 版本    | Bundle 形态                             | 许可证                                                                                                           | 风险结论                                              |
| ---------------------------------------- | ------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `@jsquash/jpeg`（JS wrapper）            | 1.6.0   | JS（ESM）                               | Apache-2.0（© 2023 jamsinclair）                                                                                 | 低：需随分发附带 LICENSE / NOTICE，保留版权与专利条款 |
| `@jsquash/jpeg` codec（MozJPEG wasm）    | 1.6.0   | `mozjpeg_dec.wasm` / `mozjpeg_enc.wasm` | IJG License + Modified BSD-3-Clause + Zlib（libjpeg-turbo 谱系；见包内 `codec/LICENSE.codec.md`）                | 低：BSD 系。文档中须含 IJG 致谢（见 §4 第 2 条）      |
| `@jsquash/png`（JS wrapper）             | 3.1.1   | JS（ESM）                               | Apache-2.0                                                                                                       | 低                                                    |
| `@jsquash/png` codec（Squoosh PNG）      | 3.1.1   | `squoosh_png_bg.wasm`                   | Apache-2.0（Squoosh v1.12.0；包内 `codec/LICENSE.codec.md` 为 Google BSD-3 文本；内含 libpng，libpng/zlib 许可） | 低：BSD/Apache 系                                     |
| `@jsquash/oxipng`（JS wrapper）          | 2.3.0   | JS（ESM）                               | Apache-2.0（© 2023 jamsinclair；Squoosh 血统）                                                                   | 低                                                    |
| `@jsquash/oxipng` codec（oxipng wasm）   | 2.3.0   | `squoosh_oxipng_bg.wasm`（ST 164KB）    | MIT（oxipng，© Joshua Holmer et al.；包内 `codec/LICENSE.codec.md`）                                             | 低：MIT                                               |
| vendored jpegtran wasm（IJG libjpeg 10） | v10     | `src/optimize/vendor/jpegtran_opt.wasm`（147KB） | IJG License（`tools/jpegtran-wasm/` 自建；README LEGAL 全文已收 THIRD_PARTY_NOTICES.md）               | 低：IJG 条款已履行（文档致谢 + 许可文本随分发） |
| `svgo`                                   | 4.1.0   | JS（ESM）                               | MIT（© Kir Belevich）                                                                                            | 低                                                    |
| `svgo` 传递依赖（bundle 内实际引入部分） | —       | JS                                      | MIT / BSD-2-Clause / BSD-3-Clause / ISC / CC0-1.0 / BlueOak-1.0.0                                                | 低：全部宽松许可；见 §4 第 1 条的自动清单             |
| Cloudflare `workerd` / Workers 运行时    | —       | 宿主平台（不随仓库分发）                | Cloudflare 服务条款                                                                                              | 不适用（非分发代码）                                  |
| `gifenc`                                 | 1.0.3   | JS（ESM）                               | MIT（© 2017 Matt DesLauriers）                                                                                   | 低                                                    |
| `omggif`                                 | 1.0.10  | JS（CJS）                               | MIT（无 LICENSE 文件，依 package 元数据；标准文本已收进 THIRD_PARTY_NOTICES.md）                                 | 低                                                    |
| `isomorphic-git`（wiki 模式）            | 1.44.15 | JS（ESM）                               | MIT（© 2017-2023 isomorphic-git authors）                                                                        | 低                                                    |
| `@cloudflare/containers`                 | 0.3.7   | JS（ESM）                               | MIT OR Apache-2.0（选 MIT）                                                                                      | 低                                                    |

传递依赖明细（`svgo` 4.1.0 依赖树，均为宽松许可）：`commander` MIT、`css-select` BSD-2-Clause、
`css-tree` MIT、`csso` MIT、`css-what` BSD-2-Clause、`domhandler` / `domutils` /
`domelementtype` / `entities` BSD-2-Clause、`mdn-data` CC0-1.0、`picocolors` ISC、
`sax` BlueOak-1.0.0、`source-map-js` BSD-3-Clause、`boolbase` ISC。

**结论**：Worker bundle 内**无 copyleft**（GPL/LGPL/AGPL/MPL）组件（P1–P2 全量核对，2026-11-17）。
唯一需要"做动作"的是 Apache-2.0 的 NOTICE 保留与 IJG/BSD 的版权声明保留——已落
`THIRD_PARTY_NOTICES.md`（完整文本）与 README IJG 致谢。GPL 面仅剩容器内 gifsicle
（进程隔离，见 §3.1 定案）。

## 2. 已评估、**未引入**的组件

| 组件                                       | 版本   | 许可证                                                                                                       | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wasm-image-optimization`（Satoru / Skia） | 2.0.13 | MIT（© 2026 SoraKumo）；内含 Skia BSD-3、libavif + AOM BSD-2/BSD-3、dav1d BSD-2、Wuffs Apache-2.0、expat MIT | **未引入**。它确有 workerd 入口（`import wasm from '.../*.wasm'` 构建期模块 + `WebAssembly.instantiate(Module)`），但 `quality` 只作用于 WebP/JPEG/AVIF；PNG 是 Skia 的无损 zlib 编码。实测 `tests/fixtures/shot.png` 在 quality = 1/30/80/100 下输出字节完全相同（均 29,598B），**无法实现有损 PNG**，故不引入（也避免 +6.9MB wasm）。若未来用于无损 PNG（其 29,598B 明显优于 `@jsquash/png` 的 86,913B），许可无阻碍，需重跑本表。 |
| `pngquant` / `libimagequant`               | —      | **GPL-3**                                                                                                    | **不采用**（见 §3）。有损 PNG 的续作路径见 `src/optimize/png.ts` 头注释。                                                                                                                                                                                                                                                                                                                                                            |

## 3. 计划中组件与 GPL 传染性分析（§9-R7）

### 3.1 `gifsicle`（P2 GIF，GPL-2）

> **已定案（2026-11-17，随 P2 落地）：组合对策 1 + 2。**
> Worker 内 GIF 走 MIT 纯 JS 的 `gifenc` 编码 + `omggif` 解码（`src/optimize/gif.ts`，
> 像素无损重建索引 + 有损 quantize）；`gifsicle` **不进 Worker bundle**，只在
> §6.3 Containers 里以原生 CLI 独立进程运行（`container/Dockerfile` 头注释同记）。
> 容器镜像分发时履行 GPL-2 §2(b)/§3：随镜像附许可证文本与源码获取方式（合规动作见 §4）。
> 压缩率与 gifsicle 的差距已按 §9-R6 记录于 `bench/RESULTS.md`（不锚定数字，契约不变）。

- 风险：把 gifsicle wasm 静态链接进 Worker bundle 并在分发 Worker 时一并分发，属于
  分发 GPL 程序的二进制形式；GPL-2 §2(b)/§3 要求整个"基于该程序的作品"按 GPL-2
  授权并提供对应源码。Worker 的业务代码与 gifsicle 同处一个编译产物，法务上很难主张
  "独立程序"，因此**默认按传染处理**。
- 对策（按推荐顺序）：
  1. **不引入 GPL 编码器**：用 MIT 的 `gifenc`（编码器）+ 自研/宽松许可的调色板量化实现
     替代。功能缺口是 gifsicle `--lossy` 的帧间优化与 dithering 质量，需要在 §6.1 登记
     压缩率差异；但许可风险归零。
  2. **独立部署**：gifsicle 只以 §6.3 Containers 的原生二进制（或独立服务）存在，
     Worker 通过 HTTP 调用，不与 Worker 代码静态链接。Linux 进程边界通常被视为
     独立程序（mere aggregation），但仍需分发该容器镜像时履行 GPL-2：附许可证文本 +
     提供对应源码获取方式。这是"要用 gifsicle 就必须做"的最低合规动作。
  3. **单独仓/单独分发**：把 gifsicle-wasm 补丁与构建脚本拆成独立 GPL-2 包，仓库整体
     采用 GPL-2 兼容许可，并在 README 明示。代价是项目自身许可证选择受限。
- 决策门：~~GIF 进入 P2 前必须先在 §9-R7 记录选择（1/2/3）；默认倾向 1。~~ **已定案：1+2 组合**（见本节顶部）。

### 3.2 `pngquant` / `libimagequant`（有损 PNG，GPL-3）

- **GPL-3**，且 GPL-3 含专利/反 Tivoization 条款，与 Apache-2.0 代码混编时的兼容性需
  逐案评审。**已定案（2026-11-17）：不引入**。有损 PNG 走 §6.1 b 路线——`gifenc`
  `quantize`（MIT）调色板量化 + jsquash 编码（`src/optimize/png.ts`），已落地并实测
  （65k 色渐变 −86.8%）。
- 若确需量化：优先 permissive 量化实现；否则退到 §3.1 的对策 2（Container 独立进程）
  并单独出具评审记录。

### 3.3 `oxipng`（P1.5 无损 PNG）

- **MIT**（Rust → wasm）。用于替代/补强 `@jsquash/png` 的无损重编码（§6.1 已登记
  `@jsquash/png` 在 `shot.png` 上反而变大）。无 copyleft 风险；引入时需更新 §1 表并
  确认 wasm 体积与构建期 import 路径（§6.2）。

## 4. 开源发布前须完成的合规动作（清单）

- [ ] **冻结依赖清单**：`npm ls --omit=dev --all` + `npm ci` 后重新生成本文件 §1/§2；
      CI 中加许可证扫描（如 `license-checker` / `licensee`），allowlist：
      MIT、Apache-2.0、BSD-2-Clause、BSD-3-Clause、ISC、CC0-1.0、Zlib、IJG、
      BlueOak-1.0.0；命中 GPL/AGPL/LGPL/MPL 即失败，例外须附评审记录。
      （2026-11-17：§1 已手动核对至 P2 全量；CI 扫描仍待加。）
- [x] **随分发附带许可证文本**（2026-11-17）：`THIRD_PARTY_NOTICES.md` 逐条收录 §1
      组件完整许可证文本与版权行（含 `@jsquash/*` codec 专项许可）；Apache-2.0 的
      NOTICE/版权与 BSD-3 免责均已保留。
- [x] **IJG 致谢**（2026-11-17）：README License 节含 Independent JPEG Group 致谢。
- [x] **公开可访问的许可证页**（2026-11-17）：README 链接 LICENSE / LICENSES.md /
      THIRD_PARTY_NOTICES.md（仓库公开即达标；站点 `/licenses` 为可选增强）。
- [x] **GIF 决策记录**（2026-11-17）：§3.1 定案 1+2 组合；gifsicle 不进 bundle。
- [x] **有损 PNG 决策记录**（2026-11-17）：§3.2 定案不引入 GPL-3 量化器，走 gifenc
      quantize（MIT）；基准见 `bench/RESULTS.md`。
- [ ] **测试夹具来源核查**：`tests/fixtures/photo.jpg`、`shot.png` 需确认可再分发
      （自摄/CC0/明确授权），否则替换；`bench/corpus/` 为脚本生成（sharp/gifenc），
      已天然可再分发。
- [x] **项目自身许可证**（2026-11-17）：`LICENSE` = MIT（与原版 Imgbot 同许可）；
      `package.json` 带 `license: "MIT"`（`private: true` 仅防误发 npm，不影响开源）。
- [ ] **部署产物审计**：每次 `wrangler deploy` 前跑一遍 allowlist 扫描；Workers 的
      源码映射/压缩产物不得剥离版权头（如无法保留，则以 NOTICE 文件补足）。
- [ ] **阶段性复核**：P1.5（oxipng）、P2（GIF）、P3 各阶段门禁时重跑本清单，并把结论
      同步进 DESIGN §9-R7 的验证列。（P2 已复核，2026-11-17。）
