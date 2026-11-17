/**
 * GIF 优化器测试（P2：omggif 解码 + gifenc 编码，纯 JS）。
 *
 * 覆盖：
 *   - 默认模式 = 像素无损：逐帧显示状态（RGBA）逐字节一致，delay / 循环次数保留；
 *   - aggressive：产物更小且可解码（不要求像素一致）；
 *   - 帧窗口（x/y 偏移）保真：合成绝对帧后显示序列一致；
 *   - 单帧 GIF 正常；
 *   - 截断/损坏输入原样返回（§6.4 绝不产出损坏文件）；
 *   - dispatch 契约：注入 codecs.gif 才参与"严格变小 + 再解码"竞争。
 *
 * 夹具现场用 gifenc（全屏帧）与 omggif 的 GifWriter（带偏移的帧窗口）构造，
 * 不引入二进制夹具。比较用"显示状态"而非单帧缓冲：这是播放器真正看到的东西。
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error -- omggif 无类型声明
import { GifReader, GifWriter } from "omggif";
// @ts-expect-error -- gifenc 无类型声明
import { GIFEncoder } from "gifenc";

import { createGifCodec } from "../src/optimize/gif";
import { optimizeImage } from "../src/optimize/dispatch";

interface DecodedGif {
  width: number;
  height: number;
  /** 每帧播放时的整屏 RGBA（已按 disposal 合成）。 */
  states: Uint8Array[];
  /** 单位 1/100 秒（GIF 原生）。 */
  delays: number[];
  loop: number | null;
}

/** 按播放器语义解码：逐帧叠加 + 处理 disposal，得到每帧的整屏显示状态。 */
function displayStates(bytes: Uint8Array): DecodedGif {
  const reader = new GifReader(bytes);
  const width: number = reader.width;
  const height: number = reader.height;
  let canvas = new Uint8Array(width * height * 4);
  let restore: Uint8Array | null = null;
  const states: Uint8Array[] = [];
  const delays: number[] = [];

  for (let i = 0; i < reader.numFrames(); i++) {
    const info = reader.frameInfo(i);
    if (info.disposal === 3) restore = canvas.slice();

    // omggif 把帧画进整屏缓冲（按 info.x/info.y 定位），透明像素不写
    const frame = new Uint8Array(width * height * 4);
    reader.decodeAndBlitFrameRGBA(i, frame);
    for (let row = 0; row < info.height; row++) {
      for (let col = 0; col < info.width; col++) {
        const s = (row * info.width + col) * 4;
        if (frame[s + 3] === 0) continue;
        const d = ((info.y + row) * width + (info.x + col)) * 4;
        canvas[d] = frame[s];
        canvas[d + 1] = frame[s + 1];
        canvas[d + 2] = frame[s + 2];
        canvas[d + 3] = 255;
      }
    }
    states.push(canvas.slice());
    delays.push(info.delay);

    if (info.disposal === 2) {
      for (let row = 0; row < info.height; row++) {
        const start = ((info.y + row) * width + info.x) * 4;
        canvas.fill(0, start, start + info.width * 4);
      }
    } else if (info.disposal === 3 && restore !== null) {
      canvas.set(restore);
    }
  }

  return { width, height, states, delays, loop: reader.loopCount() };
}

/** 在 trailer 前插入一个注释扩展（模拟真实 GIF 里的无用小块，用来保证可优化空间）。 */
function withCommentExtension(
  gif: Uint8Array,
  payloadBytes: number,
): Uint8Array {
  const blocks: number[] = [0x21, 0xfe];
  let remaining = payloadBytes;
  while (remaining > 0) {
    const size = Math.min(255, remaining);
    blocks.push(size);
    for (let i = 0; i < size; i++) blocks.push(0x2e); // '.'
    remaining -= size;
  }
  blocks.push(0); // block terminator

  // gifenc 的输出以 0x3b（trailer）结尾
  const body = gif.subarray(0, gif.length - 1);
  const out = new Uint8Array(body.length + blocks.length + 1);
  out.set(body, 0);
  out.set(blocks, body.length);
  out[out.length - 1] = 0x3b;
  return out;
}

const PALETTE = [
  [0, 0, 0], // 0 黑
  [255, 0, 0], // 1 红
  [0, 255, 0], // 2 绿
  [0, 0, 255], // 3 蓝
  [255, 255, 0], // 4 黄（在帧 1 里当透明槽用）
];

/** 8×8、3 帧、含透明帧 / 不同 delay / 重复帧 / 无限循环。 */
function animatedGif(): Uint8Array {
  const width = 8;
  const height = 8;
  const solid = (index: number): Uint8Array => {
    const pixels = new Uint8Array(width * height);
    pixels.fill(index);
    return pixels;
  };
  const halfTransparent = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      halfTransparent[y * width + x] = x < width / 2 ? 4 : 2;
    }
  }

  const encoder = GIFEncoder();
  encoder.writeFrame(solid(1), width, height, {
    palette: PALETTE,
    delay: 100,
    dispose: 1,
    repeat: 0,
  });
  encoder.writeFrame(halfTransparent, width, height, {
    palette: null,
    delay: 250,
    dispose: 1,
    transparent: true,
    transparentIndex: 4,
  });
  // 重复帧（与首帧相同）
  encoder.writeFrame(solid(1), width, height, {
    palette: null,
    delay: 100,
    dispose: 1,
  });
  encoder.finish();
  return encoder.bytes() as Uint8Array;
}

function singleFrameGif(): Uint8Array {
  const width = 6;
  const height = 4;
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % 3;
  const encoder = GIFEncoder();
  encoder.writeFrame(pixels, width, height, {
    palette: [PALETTE[0], PALETTE[1], PALETTE[2], PALETTE[3]],
    delay: 0,
    repeat: -1, // 不写 NETSCAPE 扩展
  });
  encoder.finish();
  return encoder.bytes() as Uint8Array;
}

/** 8×8 画布 + 两个带偏移的帧窗口（含透明像素），用于合成路径。 */
function offsetWindowGif(): Uint8Array {
  const width = 8;
  const height = 8;
  const palette = [0x000000, 0xff0000, 0x00ff00, 0x0000ff];
  const buffer = new Uint8Array(4096);
  const writer = new GifWriter(buffer, width, height, {
    loop: 0,
    palette,
  });

  writer.addFrame(0, 0, width, height, new Uint8Array(width * height).fill(1), {
    delay: 10,
    disposal: 1,
  });

  const window = new Uint8Array(4 * 4).fill(2);
  window[0] = 3; // 透明（显示底图的红色）
  writer.addFrame(2, 2, 4, 4, window, {
    delay: 20,
    disposal: 1,
    transparent: 3,
  });

  writer.addFrame(0, 0, 2, 2, new Uint8Array(2 * 2).fill(3), {
    delay: 30,
    disposal: 1,
  });

  const length = writer.end();
  return new Uint8Array(buffer.subarray(0, length));
}

/** 200×200、256 色调色板、单帧：用来确认 aggressive 的量化真的在起作用。 */
function manyColorGif(): Uint8Array {
  const width = 200;
  const height = 200;
  const palette: number[][] = [];
  for (let i = 0; i < 256; i++) {
    palette.push([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255]);
  }
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = (x * y + x + y) & 255;
    }
  }
  const encoder = GIFEncoder();
  encoder.writeFrame(pixels, width, height, {
    palette,
    delay: 0,
    repeat: -1,
  });
  encoder.finish();
  return encoder.bytes() as Uint8Array;
}

const codec = createGifCodec();

/** codec 契约允许同步或异步；本实现是同步的，测试里统一断言这一点。 */
function gifOptimize(bytes: Uint8Array, aggressive: boolean): Uint8Array {
  const result = codec.optimize(bytes, { aggressive });
  if (result instanceof Uint8Array) return result;
  throw new Error("GIF codec 应为同步实现");
}

describe("GIF 默认模式（像素无损）", () => {
  it("逐帧显示状态逐字节一致，delay/循环次数保留", () => {
    const original = withCommentExtension(animatedGif(), 600);
    const optimized = gifOptimize(original, false);
    expect(optimized.length).toBeLessThan(original.length);

    const before = displayStates(original);
    const after = displayStates(optimized);

    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(after.states.length).toBe(before.states.length);
    for (let i = 0; i < before.states.length; i++) {
      expect(after.states[i]).toEqual(before.states[i]);
    }
    expect(after.delays).toEqual(before.delays);
    expect(before.delays).toEqual([10, 25, 10]);
    expect(after.loop).toBe(before.loop);
    expect(after.loop).toBe(0);
  });

  it("单帧 GIF 正常（无循环扩展）", () => {
    const original = withCommentExtension(singleFrameGif(), 300);
    const optimized = gifOptimize(original, false);
    expect(optimized.length).toBeLessThan(original.length);

    const before = displayStates(original);
    const after = displayStates(optimized);
    expect(after.states.length).toBe(1);
    expect(after.states[0]).toEqual(before.states[0]);
    expect(after.loop).toBeNull();
  });

  it("帧窗口（x/y 偏移 + 透明）合成后显示序列一致", () => {
    const original = offsetWindowGif();
    const optimized = gifOptimize(original, false);

    const before = displayStates(original);
    const after = displayStates(optimized);
    expect(after.states.length).toBe(before.states.length);
    for (let i = 0; i < before.states.length; i++) {
      expect(after.states[i]).toEqual(before.states[i]);
    }
    expect(after.delays).toEqual(before.delays);
    expect(after.loop).toBe(before.loop);

    // 原件的帧窗口是 4×4 / 2×2；gifenc 不能写偏移，产物必须是合成后的全屏绝对帧
    const reader = new GifReader(optimized);
    expect(reader.width).toBe(before.width);
    expect(reader.height).toBe(before.height);
    expect(reader.numFrames()).toBe(3);
    for (let i = 0; i < reader.numFrames(); i++) {
      const info = reader.frameInfo(i);
      expect([info.x, info.y, info.width, info.height]).toEqual([
        0,
        0,
        before.width,
        before.height,
      ]);
    }
  });
});

describe("GIF × dispatch 契约", () => {
  const gifCodecs = { gif: codec };

  it("注入 codecs.gif 时参与严格变小竞争，产物可再解码", async () => {
    const original = withCommentExtension(animatedGif(), 600);
    const outcome = await optimizeImage("img/anim.gif", original, {
      codecs: gifCodecs,
    });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimized).not.toBeNull();
    expect(outcome.optimizedSize).toBe(outcome.optimized!.length);
    expect(outcome.optimizedSize!).toBeLessThan(original.length);

    // §6.4 再解码校验（dispatch 已做一次；这里独立确认产物可用）
    const decoded = displayStates(outcome.optimized!);
    expect(decoded.states.length).toBe(3);
  });

  it("未注入 codecs.gif 时维持 unsupported（P1 行为不变）", async () => {
    const outcome = await optimizeImage("img/anim.gif", animatedGif(), {});
    expect(outcome.skipped).toBe("unsupported");
    expect(outcome.optimized).toBeNull();
  });

  it("aggressive 产物更小且可解码（不要求像素一致）", async () => {
    const original = withCommentExtension(animatedGif(), 600);
    const outcome = await optimizeImage("img/anim.gif", original, {
      codecs: gifCodecs,
      aggressive: true,
    });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimizedSize!).toBeLessThan(original.length);

    const decoded = displayStates(outcome.optimized!);
    expect(decoded.states.length).toBe(3);
    expect(decoded.delays).toEqual([10, 25, 10]);
  });

  it("aggressive 对多色 GIF 量化生效（比无损候选更小）且可解码", () => {
    const original = manyColorGif();
    const lossless = gifOptimize(original, false);
    const aggressive = gifOptimize(original, true);

    expect(aggressive.length).toBeLessThan(lossless.length);
    expect(displayStates(aggressive).states.length).toBe(1);
  });

  it("截断输入原样返回，绝不产出损坏文件", () => {
    const original = animatedGif();
    const truncated = original.slice(0, Math.floor(original.length * 0.6));
    const optimized = gifOptimize(truncated, false);
    expect(optimized.length).toBe(truncated.length);
    expect(optimized).toEqual(truncated);

    // 非 GIF 字节同样原样返回
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(gifOptimize(junk, true)).toEqual(junk);
  });

  it("截断输入经 dispatch 归为 not_smaller（不替换）", async () => {
    const original = animatedGif();
    const truncated = original.slice(0, Math.floor(original.length * 0.6));
    const outcome = await optimizeImage("anim.gif", truncated, {
      codecs: gifCodecs,
    });
    expect(outcome.optimized).toBeNull();
    expect(outcome.skipped).toBe("not_smaller");
  });
});

