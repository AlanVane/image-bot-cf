# 第三方组件许可证与合规清单

> 范围：随 Cloudflare Worker bundle 一起分发（编译进 `dist/`）的代码与 wasm，以及 P2/P1.5
> 计划引入的编解码器。对应 DESIGN.md §6.1（格式 × 模式 × codec）与 §9-R7（GPL 传染性）。
>
> 最近核对：2026-11-17（依据 `package-lock.json` 与 `node_modules` 内的 LICENSE 文件）。
> 依赖或 bundle 变化时须重新生成此表。

## 1. 当前 bundle 内组件（P1）

| 组件                                     | 版本  | Bundle 形态                             | 许可证                                                                                                           | 风险结论                                              |
| ---------------------------------------- | ----- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `@jsquash/jpeg`（JS wrapper）            | 1.6.0 | JS（ESM）                               | Apache-2.0（© 2023 jamsinclair）                                                                                 | 低：需随分发附带 LICENSE / NOTICE，保留版权与专利条款 |
| `@jsquash/jpeg` codec（MozJPEG wasm）    | 1.6.0 | `mozjpeg_dec.wasm` / `mozjpeg_enc.wasm` | IJG License + Modified BSD-3-Clause + Zlib（libjpeg-turbo 谱系；见包内 `codec/LICENSE.codec.md`）                | 低：BSD 系。文档中须含 IJG 致谢（见 §4 第 2 条）      |
| `@jsquash/png`（JS wrapper）             | 3.1.1 | JS（ESM）                               | Apache-2.0                                                                                                       | 低                                                    |
| `@jsquash/png` codec（Squoosh PNG）      | 3.1.1 | `squoosh_png_bg.wasm`                   | Apache-2.0（Squoosh v1.12.0；包内 `codec/LICENSE.codec.md` 为 Google BSD-3 文本；内含 libpng，libpng/zlib 许可） | 低：BSD/Apache 系                                     |
| `svgo`                                   | 4.1.0 | JS（ESM）                               | MIT（© Kir Belevich）                                                                                            | 低                                                    |
| `svgo` 传递依赖（bundle 内实际引入部分） | —     | JS                                      | MIT / BSD-2-Clause / BSD-3-Clause / ISC / CC0-1.0 / BlueOak-1.0.0                                                | 低：全部宽松许可；见 §4 第 1 条的自动清单             |
| Cloudflare `workerd` / Workers 运行时    | —     | 宿主平台（不随仓库分发）                | Cloudflare 服务条款                                                                                              | 不适用（非分发代码）                                  |

传递依赖明细（`svgo` 4.1.0 依赖树，均为宽松许可）：`commander` MIT、`css-select` BSD-2-Clause、
`css-tree` MIT、`csso` MIT、`css-what` BSD-2-Clause、`domhandler` / `domutils` /
`domelementtype` / `entities` BSD-2-Clause、`mdn-data` CC0-1.0、`picocolors` ISC、
`sax` BlueOak-1.0.0、`source-map-js` BSD-3-Clause、`boolbase` ISC。

**结论**：P1 bundle 内无 copyleft（GPL/LGPL/AGPL/MPL）组件。唯一需要"做动作"的是
Apache-2.0 的 NOTICE 保留与 IJG/BSD 的版权声明保留（见 §4）。

## 2. 已评估、**未引入**的组件

| 组件                                       | 版本   | 许可证                                                                                                       | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wasm-image-optimization`（Satoru / Skia） | 2.0.13 | MIT（© 2026 SoraKumo）；内含 Skia BSD-3、libavif + AOM BSD-2/BSD-3、dav1d BSD-2、Wuffs Apache-2.0、expat MIT | **未引入**。它确有 workerd 入口（`import wasm from '.../*.wasm'` 构建期模块 + `WebAssembly.instantiate(Module)`），但 `quality` 只作用于 WebP/JPEG/AVIF；PNG 是 Skia 的无损 zlib 编码。实测 `tests/fixtures/shot.png` 在 quality = 1/30/80/100 下输出字节完全相同（均 29,598B），**无法实现有损 PNG**，故不引入（也避免 +6.9MB wasm）。若未来用于无损 PNG（其 29,598B 明显优于 `@jsquash/png` 的 86,913B），许可无阻碍，需重跑本表。 |
| `pngquant` / `libimagequant`               | —      | **GPL-3**                                                                                                    | **不采用**（见 §3）。有损 PNG 的续作路径见 `src/optimize/png.ts` 头注释。                                                                                                                                                                                                                                                                                                                                                            |

## 3. 计划中组件与 GPL 传染性分析（§9-R7）

### 3.1 `gifsicle`（P2 GIF，GPL-2）

- 计划用 wasm 版 `gifsicle -O3` / `--lossy`（DESIGN §6.1）。**GPL-2**。
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
- 决策门：GIF 进入 P2 前必须先在 §9-R7 记录选择（1/2/3）；默认倾向 1。

### 3.2 `pngquant` / `libimagequant`（有损 PNG，GPL-3）

- **GPL-3**，且 GPL-3 含专利/反 Tivoization 条款，与 Apache-2.0 代码混编时的兼容性需
  逐案评审。P1 结论：不引入 wasm 版，aggressive PNG 暂与无损同路。
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
- [ ] **随分发附带许可证文本**：仓库根放 `THIRD_PARTY_NOTICES.md`（或 `NOTICE`），
      逐条收录 §1 组件的完整许可证文本与版权行；Apache-2.0 组件（`@jsquash/*`）保留其
      NOTICE（若有）；BSD-3 组件保留版权声明与免责声明。
- [ ] **IJG 致谢**：文档/README 中加入 Independent JPEG Group 的致谢措辞（MozJPEG 走
      libjpeg-turbo 谱系，IJG License 要求在文档中致谢）。
- [ ] **公开可访问的许可证页**：bundle 是编译产物，无法内嵌可读许可证；须在仓库 +
      站点（如 `/licenses`）提供本文件与第三方文本的可访问副本，并在 README 链接。
- [ ] **GIF 决策记录**：GIF（P2）落地前在 §9-R7 写明 §3.1 的选择；默认走 `gifenc`
      或 Container 独立进程，**不得**把 gifsicle wasm 静态链入 Worker 后直接开源分发。
- [ ] **有损 PNG 决策记录**：若未来引入量化器，附许可证评审（GPL-3 或替代方案）与
      压缩率/画质基准，再更新 §1/§2。
- [ ] **测试夹具来源核查**：`tests/fixtures/photo.jpg`、`shot.png`、`bench/` 夹具在上游
      仓库公开前需确认可再分发（自摄/CC0/明确授权），否则替换为生成夹具。
- [ ] **项目自身许可证**：公开仓库前确定 `LICENSE`（当前 `package.json` 为
      `"private": true`）；若选择 GPL-2 之外的宽松许可，需再次确认 §3 的 GPL 组件均未
      进入 bundle。
- [ ] **部署产物审计**：每次 `wrangler deploy` 前跑一遍 allowlist 扫描；Workers 的
      源码映射/压缩产物不得剥离版权头（如无法保留，则以 NOTICE 文件补足）。
- [ ] **阶段性复核**：P1.5（oxipng）、P2（GIF）、P3 各阶段门禁时重跑本清单，并把结论
      同步进 DESIGN §9-R7 的验证列。
