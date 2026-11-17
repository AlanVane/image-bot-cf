// 20 图基准语料生成器（DESIGN.md P1 DoD #3 / §9-R6）。
// 确定性：seeded PRNG + 固定尺寸/参数；同机同 sharp 版本输出逐字节稳定。
// 用法：node bench/generate-corpus.mjs   → 产出 bench/corpus/01..20
import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const OUT = new URL("./corpus/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// mulberry32：小而稳的 seeded PRNG
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

const noise = rng(0xc0ffee);
function n() {
  return (noise() - 0.5) * 44; // ±22 振幅：类照片熵但不至于撑爆 PNG
}

function photoPainter(seedShift) {
  return (x, y) => {
    const v = 96 + (x + y * 0.7) * 0.06 + seedShift + n();
    return [
      Math.max(0, Math.min(255, v + 28 * Math.sin(x / 90))),
      Math.max(0, Math.min(255, v + 12 * Math.cos(y / 70))),
      Math.max(0, Math.min(255, v * 0.9 + 20)),
    ];
  };
}

function blockPainter(palette, cell) {
  return (x, y) => palette[Math.floor(x / cell + (Math.floor(y / cell) * 7)) % palette.length];
}

const files = [];
const save = async (name, pipeline) => {
  const buf = await pipeline.toBuffer();
  writeFileSync(OUT + name, buf);
  files.push([name, buf.length]);
};

// ---------- JPEG ×5 ----------
await save("01-jpeg-photo.jpg", rawImage(1600, 1200, photoPainter(0)).jpeg({ quality: 82 }));
await save(
  "02-jpeg-screenshot.jpg",
  rawImage(1366, 768, blockPainter([[245, 246, 241], [74, 124, 89], [221, 227, 213], [30, 40, 34], [255, 255, 255]], 44)).jpeg({ quality: 85 }),
);
// 03：1024×768 照片 + ~10KB COM 元数据（段剥离收益的代表）
{
  const base = await rawImage(1024, 768, photoPainter(9)).jpeg({ quality: 82 });
  const bytes = new Uint8Array(await base.toBuffer());
  const parts = [];
  for (let k = 0; k < 5; k += 1) {
    const payload = new TextEncoder().encode(`metadata-blob-${"x".repeat(1990)}-${k}`);
    const seg = new Uint8Array(4 + payload.length);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg[2] = ((payload.length + 2) >> 8) & 0xff;
    seg[3] = (payload.length + 2) & 0xff;
    seg.set(payload, 4);
    parts.push(seg);
  }
  const withCom = Buffer.concat([Buffer.from(bytes.subarray(0, 2)), ...parts.map((p) => Buffer.from(p)), Buffer.from(bytes.subarray(2))]);
  writeFileSync(OUT + "03-jpeg-metadata.jpg", withCom);
  files.push(["03-jpeg-metadata.jpg", withCom.length]);
}
await save("04-jpeg-thumb.jpg", rawImage(200, 150, photoPainter(3)).jpeg({ quality: 80 }));
await save(
  "05-jpeg-scan.jpg",
  rawImage(1200, 1600, (x, y) => {
    const line = y % 26 < 6 && x > 80 && x < 1120 ? 205 : 248;
    return [line, line, line - 2];
  }).jpeg({ quality: 88 }),
);

// ---------- PNG ×6 ----------
await save("06-png-photo.png", rawImage(900, 675, photoPainter(1)).png());
await save(
  "07-png-screenshot.png",
  rawImage(1366, 768, blockPainter([[245, 246, 241], [74, 124, 89], [221, 227, 213], [30, 40, 34], [255, 255, 255]], 44)).png(),
);
await save(
  "08-png-palette.png",
  rawImage(640, 480, blockPainter([[245, 246, 241], [74, 124, 89], [221, 227, 213], [30, 40, 34], [180, 60, 60], [60, 90, 180]], 16)).png(),
);
// 09：透明图标（圆形 + 透明底，RGBA）
{
  const w = 256;
  const data = Buffer.alloc(w * w * 4);
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.hypot(x - 128, y - 128);
      const i = (y * w + x) * 4;
      const inside = d < 110;
      data[i] = 74;
      data[i + 1] = 124;
      data[i + 2] = 89;
      data[i + 3] = inside ? (d > 92 ? 128 : 255) : 0;
    }
  }
  await save("09-png-transparent.png", sharp(data, { raw: { width: w, height: w, channels: 4 } }).png());
}
await save(
  "10-png-text.png",
  rawImage(1200, 800, (x, y) => {
    const inText = y % 22 < 9 && x > 60 + (y % 44) * 6 && x < 60 + (y % 44) * 6 + 780;
    return inText ? [28, 30, 28] : [252, 252, 250];
  }).png(),
);
{
  // 11：平滑渐变（16-bit 管线，sharp 不支持时回落 8-bit 并在名后标注）
  let pipeline = rawImage(800, 600, (x) => [x * 0.3, x * 0.28 + 40, 255 - x * 0.2]);
  try {
    pipeline = pipeline.toColourspace("rgb16");
    await save("11-png-gradient.png", pipeline.png());
  } catch {
    await save("11-png-gradient.png", pipeline.png());
    console.log("note: rgb16 unavailable, 11-png-gradient.png is 8-bit");
  }
}

// ---------- GIF ×3（gifenc） ----------
const gifencMod = await import("gifenc");
const { GIFEncoder, quantize, applyPalette } = gifencMod.default ?? gifencMod;
function gifFrame(w, h, painter) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = painter(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}
{
  const w = 300;
  const h = 200;
  const data = gifFrame(w, h, blockPainter([[245, 246, 241], [74, 124, 89], [221, 227, 213], [30, 40, 34]], 25));
  const palette = quantize(data, 64);
  const index = applyPalette(data, palette);
  const gif = GIFEncoder();
  gif.writeFrame(index, w, h, { palette, delay: 0 });
  gif.finish();
  writeFileSync(OUT + "12-gif-static.gif", Buffer.from(gif.bytes()));
  files.push(["12-gif-static.gif", gif.bytes().length]);
}
{
  const w = 200;
  const h = 150;
  const gif = GIFEncoder();
  for (let f = 0; f < 10; f += 1) {
    const data = gifFrame(w, h, (x, y) => {
      const band = (x + f * 20) % 60;
      return band < 30 ? [74, 124, 89] : [221, 227, 213];
    });
    const palette = quantize(data, 32);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, w, h, { palette, delay: 60 });
  }
  gif.finish();
  writeFileSync(OUT + "13-gif-animated.gif", Buffer.from(gif.bytes()));
  files.push(["13-gif-animated.gif", gif.bytes().length]);
}
{
  // 14：静态 GIF + 注释扩展块（0x21 0xFE … 0x00）
  // 位置必须在 Header + LSD(+GCT) 之后；插在中间会被误读为超大尺寸。
  const w = 300;
  const h = 200;
  const data = gifFrame(w, h, blockPainter([[255, 255, 255], [180, 60, 60], [60, 90, 180]], 20));
  const palette = quantize(data, 64);
  const index = applyPalette(data, palette);
  const gif = GIFEncoder();
  gif.writeFrame(index, w, h, { palette, delay: 0 });
  gif.finish();
  const bytes = gif.bytes();
  // Header(6) + LSD(7)；packed 字段 bit7 = GCT 标志，size = 2^((packed&7)+1)*3
  const packed = bytes[10];
  const gctSize = packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  const insertAt = 6 + 7 + gctSize;
  const comment = new TextEncoder().encode(`x-comment-${"y".repeat(1500)}`);
  // GIF 扩展数据 = ≤255B 子块序列 + 0x00 终止符
  const ext = [0x21, 0xfe];
  for (let i = 0; i < comment.length; i += 255) {
    const chunk = comment.subarray(i, i + 255);
    ext.push(chunk.length, ...chunk);
  }
  ext.push(0x00);
  const out = Buffer.concat([
    Buffer.from(bytes.subarray(0, insertAt)),
    Buffer.from(ext),
    Buffer.from(bytes.subarray(insertAt)),
  ]);
  writeFileSync(OUT + "14-gif-comments.gif", out);
  files.push(["14-gif-comments.gif", out.length]);
}

// ---------- SVG ×3 ----------
{
  const cells = [];
  for (let i = 0; i < 240; i += 1) {
    const x = 12 + (i % 20) * 36;
    const y = 12 + Math.floor(i / 20) * 30;
    cells.push(`
    <!-- decorative cell ${i}: repeated gradient marker -->
    <g id="cell-group-${i}" transform="translate(${x}, ${y})" opacity="1" fill-opacity="1.0" stroke-opacity="1">
      <rect x="0" y="0" width="28" height="22" rx="4" ry="4"
            fill="#4a7c59" stroke="#2f533b" stroke-width="1"
            style="fill: #4a7c59; stroke: #2f533b;" />
      <text x="14" y="15" font-family="sans-serif" font-size="9"
            text-anchor="middle" fill="#f5f6f1" xml:space="preserve">${i}</text>
    </g>
  `);
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- verbose hand-authored sample: expect multipass svgo savings -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     version="1.1" width="740" height="380" viewBox="0 0 740 380">
  <title>Verbose sample board</title>
  <desc>Whitespace and comments intentionally redundant.</desc>
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f5f6f1" stop-opacity="1" />
      <stop offset="100%" stop-color="#dde3d5" stop-opacity="1" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="740" height="380" fill="url(#bg)" />
${cells.join("")}
</svg>
`;
  writeFileSync(OUT + "15-svg-verbose.svg", svg);
  files.push(["15-svg-verbose.svg", svg.length]);
}
{
  const icons = [];
  for (let i = 0; i < 120; i += 1) {
    const cx = 24 + (i % 24) * 30;
    const cy = 24 + Math.floor(i / 24) * 30;
    icons.push(
      `<g id="icon-${i}" transform="translate(${cx},${cy})"><circle cx="0" cy="0" r="10" fill="#4a7c59"/><path d="M -4 0 L 0 4 L 6 -4" stroke="#f5f6f1" stroke-width="2" fill="none"/></g>`,
    );
  }
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="740" height="160" viewBox="0 0 740 160">\n${icons.join("\n")}\n</svg>\n`;
  writeFileSync(OUT + "16-svg-sprite.svg", svg);
  files.push(["16-svg-sprite.svg", svg.length]);
}
{
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#4a7c59"/><path d="M30 50l14 14 26-28" stroke="#fff" stroke-width="6" fill="none"/></svg>';
  writeFileSync(OUT + "17-svg-minified.svg", svg);
  files.push(["17-svg-minified.svg", svg.length]);
}

// ---------- 边界 ×3 ----------
await save(
  "18-edge-tiny.png",
  rawImage(32, 32, blockPainter([[74, 124, 89], [245, 246, 241]], 8)).png(),
);
await save("19-edge-large.jpg", rawImage(2560, 1440, blockPainter([[245, 246, 241], [74, 124, 89], [221, 227, 213], [30, 40, 34], [255, 255, 255]], 48)).jpeg({ quality: 82 }));
await save("20-edge-cmyk.jpg", rawImage(800, 600, photoPainter(5)).toColourspace("cmyk").jpeg({ quality: 82 }));

console.log("generated", files.length, "fixtures:");
for (const [name, size] of files) console.log(`  ${name.padEnd(26)} ${String(size).padStart(9)} B`);
