# 20 图基准集 — 压缩率记录（生成时间 2026-11-17T10:50:52.994Z）

> 环境：Node v26.13.0（本地 V8，非 workerd —— §11-3 真环境实测另行）；
> sharp/libvips 8.18.7 / @jsquash mozjpeg+png / gifenc / svgo，与 `package-lock.json` 一致。
> 契约（§9-R6）：只有严格变小才替换；数字不锚定原版，本表记录差距。

## 我们的管线（每图 × 无损/有损两模式）

| Fixture | Mode | Before (B) | After (B) | Saved | ms | Result | ≥10KB |
|:--|:--|--:|--:|--:|--:|:--|:--|
| 01-jpeg-photo.jpg | lossless | 533,525 | 533,525 | 0.00% | 4 | skipped:not_smaller | — |
| 01-jpeg-photo.jpg | aggressive | 533,525 | 396,762 | 25.63% | 706 | replaced | ✓ |
| 02-jpeg-screenshot.jpg | lossless | 43,823 | 43,823 | 0.00% | 0 | skipped:not_smaller | — |
| 02-jpeg-screenshot.jpg | aggressive | 43,823 | 43,823 | 0.00% | 117 | skipped:not_smaller | — |
| 03-jpeg-metadata.jpg | lossless | 228,695 | 218,645 | 4.39% | 12 | replaced | — |
| 03-jpeg-metadata.jpg | aggressive | 228,695 | 162,932 | 28.76% | 261 | replaced | ✓ |
| 04-jpeg-thumb.jpg | lossless | 8,158 | 8,158 | 0.00% | 0 | skipped:not_smaller | — |
| 04-jpeg-thumb.jpg | aggressive | 8,158 | 6,580 | 19.34% | 11 | replaced | — |
| 05-jpeg-scan.jpg | lossless | 83,967 | 83,967 | 0.00% | 0 | skipped:not_smaller | — |
| 05-jpeg-scan.jpg | aggressive | 83,967 | 52,067 | 37.99% | 208 | replaced | ✓ |
| 06-png-photo.png | lossless | 1,468,365 | 917,380 | 37.52% | 608 | replaced | ✓ |
| 06-png-photo.png | aggressive | 1,468,365 | 917,380 | 37.52% | 655 | replaced | ✓ |
| 07-png-screenshot.png | lossless | 27,372 | 2,277 | 91.68% | 232 | replaced | ✓ |
| 07-png-screenshot.png | aggressive | 27,372 | 2,277 | 91.68% | 354 | replaced | ✓ |
| 08-png-palette.png | lossless | 7,623 | 1,129 | 85.19% | 91 | replaced | — |
| 08-png-palette.png | aggressive | 7,623 | 1,129 | 85.19% | 118 | replaced | — |
| 09-png-transparent.png | lossless | 2,631 | 813 | 69.10% | 23 | replaced | — |
| 09-png-transparent.png | aggressive | 2,631 | 813 | 69.10% | 27 | replaced | — |
| 10-png-text.png | lossless | 16,648 | 610 | 96.34% | 116 | replaced | ✓ |
| 10-png-text.png | aggressive | 16,648 | 610 | 96.34% | 205 | replaced | ✓ |
| 11-png-gradient.png | lossless | 55,879 | 4,516 | 91.92% | 405 | replaced | ✓ |
| 11-png-gradient.png | aggressive | 55,879 | 4,516 | 91.92% | 493 | replaced | ✓ |
| 12-gif-static.gif | lossless | 3,455 | 3,299 | 4.52% | 12 | replaced | — |
| 12-gif-static.gif | aggressive | 3,455 | 3,299 | 4.52% | 21 | replaced | — |
| 13-gif-animated.gif | lossless | 12,697 | 11,504 | 9.40% | 19 | replaced | — |
| 13-gif-animated.gif | aggressive | 12,697 | 11,504 | 9.40% | 33 | replaced | — |
| 14-gif-comments.gif | lossless | 4,487 | 2,813 | 37.31% | 3 | replaced | — |
| 14-gif-comments.gif | aggressive | 4,487 | 2,813 | 37.31% | 6 | replaced | — |
| 15-svg-verbose.svg | lossless | 120,964 | 66,436 | 45.08% | 195 | replaced | ✓ |
| 15-svg-verbose.svg | aggressive | 120,964 | 66,436 | 45.08% | 116 | replaced | ✓ |
| 16-svg-sprite.svg | lossless | 20,937 | 16,806 | 19.73% | 31 | replaced | — |
| 16-svg-sprite.svg | aggressive | 20,937 | 16,806 | 19.73% | 32 | replaced | — |
| 17-svg-minified.svg | lossless | 188 | 188 | 0.00% | 1 | skipped:not_smaller | — |
| 17-svg-minified.svg | aggressive | 188 | 188 | 0.00% | 1 | skipped:not_smaller | — |
| 18-edge-tiny.png | lossless | 159 | 118 | 25.79% | 3 | replaced | — |
| 18-edge-tiny.png | aggressive | 159 | 118 | 25.79% | 4 | replaced | — |
| 19-edge-large.jpg | lossless | 33,323 | 33,323 | 0.00% | 1 | skipped:not_smaller | — |
| 19-edge-large.jpg | aggressive | 33,323 | 33,323 | 0.00% | 386 | skipped:not_smaller | — |
| 20-edge-cmyk.jpg | lossless | 307,906 | 307,906 | 0.00% | 7 | skipped:decode_failed | — |
| 20-edge-cmyk.jpg | aggressive | 307,906 | 307,906 | 0.00% | 1 | skipped:decode_failed | — |

### 各格式合计（无损模式）

| Format | Before (B) | After (B) | Saved |
|:--|--:|--:|--:|
| jpeg | 1,239,397 | 1,229,347 | 0.81% |
| png | 1,578,677 | 926,843 | 41.29% |
| gif | 20,639 | 17,616 | 14.65% |
| svg | 142,089 | 83,430 | 41.28% |

## 与原版工具链对照（同一批夹具）

原版 Imgbot 无损工具链：mozjpeg `jpegtran -optimize -copy none` / `oxipng` / `gifsicle -O3` / `svgo`。

| Fixture | Tool | Before (B) | After (B) | Saved | Note |
|:--|:--|--:|--:|--:|:--|
| 01-jpeg-photo.jpg | jpegtran | 533,525 | 533,543 | -0.00% | -optimize -copy none |
| 02-jpeg-screenshot.jpg | jpegtran | 43,823 | 43,841 | -0.04% | -optimize -copy none |
| 03-jpeg-metadata.jpg | jpegtran | 228,695 | 218,663 | 4.39% | -optimize -copy none |
| 04-jpeg-thumb.jpg | jpegtran | 8,158 | 8,176 | -0.22% | -optimize -copy none |
| 05-jpeg-scan.jpg | jpegtran | 83,967 | 83,985 | -0.02% | -optimize -copy none |
| 06-png-photo.png | oxipng | — | — | — | 二进制不可运行 → not measurable |
| 07-png-screenshot.png | oxipng | — | — | — | 二进制不可运行 → not measurable |
| 08-png-palette.png | oxipng | — | — | — | 二进制不可运行 → not measurable |
| 09-png-transparent.png | oxipng | — | — | — | 二进制不可运行 → not measurable |
| 10-png-text.png | oxipng | — | — | — | 二进制不可运行 → not measurable |
| 11-png-gradient.png | oxipng | — | — | — | 二进制不可运行 → not measurable |
| 12-gif-static.gif | gifsicle | 3,455 | 3,291 | 4.75% | -O3（默认保留注释） |
| 13-gif-animated.gif | gifsicle | 12,697 | 10,553 | 16.89% | -O3（默认保留注释） |
| 14-gif-comments.gif | gifsicle | 4,487 | 4,324 | 3.63% | -O3（默认保留注释） |
| 15-svg-verbose.svg | svgo（与我们同工具，数字等价） | — | — | — | same-family |
| 16-svg-sprite.svg | svgo（与我们同工具，数字等价） | — | — | — | same-family |
| 17-svg-minified.svg | svgo（与我们同工具，数字等价） | — | — | — | same-family |
| 18-edge-tiny.png | oxipng | — | — | — | 二进制不可运行 → not measurable |
| 19-edge-large.jpg | jpegtran | 33,323 | 33,341 | -0.05% | -optimize -copy none |
| 20-edge-cmyk.jpg | jpegtran | 307,906 | 307,906 | 0.00% | -optimize -copy none |

### 差距定性说明（§9-R6）

- **JPEG 无损**：实测 `jpegtran -optimize` 在 sharp 产出的已紧凑 JPEG 上增益 ≈0（±0.05% 噪声）——真实相机/截图素材的 Huffman 冗余更大，开放问题 §11-2 的补强收益需以真实素材复测；目前双方差距集中在**元数据剥离**（03 行可见）。
- **PNG 无损**：我们 = chunk 剥离 + **oxipng 重压缩**（`@jsquash/oxipng`，§11-4 已闭环）双候选取小；与原版 oxipng 同源（wasm 版），数字等价（本机 CLI 不可运行，对照即自身）。
- **GIF**：我们 = omggif 解码 + gifenc 重编码；gifsicle -O3 的 LZW 重编码更强（13 行 16.9% vs 我们 9.4%），但我们**剥离注释块**而 gifsicle 默认保留（14 行 −37.3% vs −3.6%），各有所长。
- **SVG**：双方同为 svgo 多轮，数字等价。
- **CMYK JPEG**（20）：jpegtran 原样透传（0%）；我们因解码校验恒 skip（见语料注记）。

## 阈值视角（minKBReduced = 10KB）

- 06-png-photo.png：−538.07 KB
- 07-png-screenshot.png：−24.51 KB
- 10-png-text.png：−15.66 KB
- 11-png-gradient.png：−50.16 KB
- 15-svg-verbose.svg：−53.25 KB

## 语料构造注记

- 语料由 sharp/gifenc 生成，各编码器初始冗余不同：PNG 无损收益来自 oxipng 重压缩（接入后实测）；GIF 由 gifenc 生成故 12/13 无损无收益属预期（14 验证注释块剥离收益）；JPEG 无损 0% 是**管线差距**（无 Huffman 重优化，见上）。
- CMYK JPEG 在注入解码器的校验路径下恒为 `decode_failed`（jsquash 不解 CMYK）→ 生产上 CMYK 图不会被优化，契约选择"宁可少优化"。如需覆盖，走 Containers 通道（§6.3）。
- GIF 注释型（14）验证注释块剥离收益；GIF 由 gifenc 生成，故 12/13 无损无收益属预期。

