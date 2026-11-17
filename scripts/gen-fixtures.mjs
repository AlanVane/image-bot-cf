#!/usr/bin/env node
/**
 * 测试/基准夹具生成器（LICENSES.md §4"测试夹具来源核查"的定案）。
 *
 * 2026-11-17：原 photo.jpg / shot.png 来源不明（疑似网络素材），不可再分发 →
 * 一律替换为本脚本**生成**的等效素材（确定性：seeded PRNG + 固定参数）。
 * 夹具改动后须重跑 `npm test` 并同步 DESIGN §6.1 的实测数字。
 *
 * 产出（4 个文件，均覆盖写）：
 *   tests/fixtures/photo.jpg  tests/fixtures/shot.png
 *   bench/photo.jpg           bench/shot.png（bench/bench.mjs 使用同名副本）
 *
 * 用法：node scripts/gen-fixtures.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const root = new URL("..", import.meta.url).pathname;

// mulberry32：确定性噪声
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rawImage(width, height, painter) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = painter(x, y);
      const i = (y * width + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } });
}

const noise = rng(0xbadc0de);
const n = () => (noise() - 0.5) * 44;

/** photo.jpg：类照片（渐变 + 低幅噪声），2000×1500（3MP，测试契约锚定此尺寸），q82。 */
async function photoJpeg() {
  const buf = await rawImage(2000, 1500, (x, y) => {
    const v = 96 + (x + y * 0.7) * 0.06 + n();
    return [
      Math.max(0, Math.min(255, v + 28 * Math.sin(x / 90))),
      Math.max(0, Math.min(255, v + 12 * Math.cos(y / 70))),
      Math.max(0, Math.min(255, v * 0.9 + 20)),
    ];
  })
    .jpeg({ quality: 82 })
    .toBuffer();
  // mozjpeg 可能省略 JFIF APP0；测试契约要求标记表含 0xE0 → 保证有 APP0。
  const bytes = new Uint8Array(buf);
  if (bytes[2] !== 0xff || bytes[3] !== 0xe0) {
    const app0 = Buffer.from([
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00,
      0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    ]);
    return Buffer.concat([Buffer.from(bytes.subarray(0, 2)), app0, Buffer.from(bytes.subarray(2))]);
  }
  return buf;
}

/** PNG CRC32（注入辅助 chunk 用）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, 8 + data.length)) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** shot.png：类截图（平色块 + 文本状条纹），2000×1500，带 tEXt/eXIf 可剥离 chunk。 */
async function shotPng() {
  const buf = await rawImage(2000, 1500, (x, y) => {
    if (y < 48) return [30, 40, 34];
    if (x < 220) return [74, 124, 89];
    const inText = y % 22 < 9 && x > 260 + (y % 44) * 4 && x < 260 + (y % 44) * 4 + 1200;
    return inText ? [28, 30, 28] : [245, 246, 241];
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
  // 注入 tEXt ×2 + eXIf（chunk 剥离测试要求 stripPngMetadata 严格变小）。
  // 位置必须在 IHDR 之后、首个 IDAT 之前（IHDR 必须是第一个 chunk，lodepng 强校验）。
  const bytes = new Uint8Array(buf);
  const chunks = [
    pngChunk("tEXt", Buffer.from(`Comment\x00${"generated fixture ".repeat(80)}`)),
    pngChunk("tEXt", Buffer.from(`Software\x00gen-fixtures.mjs ${"x".repeat(400)}`)),
    pngChunk("eXIf", Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08])),
  ];
  // 找首个 IDAT 的起始偏移
  let insertAt = 8;
  for (;;) {
    const length =
      (bytes[insertAt] << 24) |
      (bytes[insertAt + 1] << 16) |
      (bytes[insertAt + 2] << 8) |
      bytes[insertAt + 3];
    const type = String.fromCharCode(
      ...bytes.subarray(insertAt + 4, insertAt + 8),
    );
    if (type === "IDAT") break;
    insertAt += 12 + length;
  }
  return Buffer.concat([
    Buffer.from(bytes.subarray(0, insertAt)),
    ...chunks,
    Buffer.from(bytes.subarray(insertAt)),
  ]);
}

const outputs = [
  ["tests/fixtures/photo.jpg", await photoJpeg()],
  ["tests/fixtures/shot.png", await shotPng()],
];

mkdirSync(`${root}bench`, { recursive: true });
for (const [rel, buf] of outputs) {
  writeFileSync(`${root}${rel}`, buf);
  const benchRel = rel.replace("tests/fixtures/", "bench/");
  writeFileSync(`${root}${benchRel}`, buf);
  console.log(`${rel} + ${benchRel} <- ${buf.length} B`);
}
