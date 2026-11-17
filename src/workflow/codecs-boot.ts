/**
 * 编解码器装配（DESIGN.md §6.2）—— 唯一的 wasm 入口。
 *
 * **硬性约束**：workerd 禁用 `WebAssembly.compile` / `compileStreaming` /
 * `instantiate(bytes)` / `instantiateStreaming`，`@jsquash` 默认的 fetch 加载器
 * 在 workerd 上直接不可用。因此这里只做**构建期 import**：wrangler 打包时把
 * `.wasm` 文件编译成 `WebAssembly.Module`（`src/wasm.d.ts` 声明形状），
 * 再由 `initCodecsFromModules()` 注入给 `@jsquash` 的 `init(module)`。
 *
 * 本文件（以及 `src/` 下任何代码）**禁止**出现 `WebAssembly.compile` /
 * `instantiate(bytes)` / fetch wasm —— 这是 §6.2 的静态检查项。
 *
 * 生命周期：模块级 promise 记忆化。同 isolate 内所有 run/step 共用一次装配；
 * isolate 被回收后模块状态随之消失，新 isolate 首次调用自然重跑装配。
 * 装配失败（OOM、模块损坏）时清空缓存，下次调用重试 —— 即"自愈"。
 */

import * as pngWasmBindings from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import jpegDecWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import jpegEncWasm from "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm";

import { initCodecsFromModules } from "../optimize/dispatch";
import { createGifCodec } from "../optimize/gif";
import type { CodecSet } from "../types";

/**
 * 已装配的编解码器集合。`undefined` = 尚未开始；`Promise` = 装配中或已完成。
 * 不导出可变引用，避免调用方误改（`initCodecsFromModules` 返回的 CodecSet 是共享只读对象）。
 */
let codecSetPromise: Promise<CodecSet> | null = null;

/**
 * `@jsquash/png/codec/pkg/squoosh_png_bg.wasm.d.ts`（wbindgen 生成的绑定声明）会遮蔽
 * 本仓库的 `*.wasm` 环境声明，TS 因此只看到命名导出。运行时 wrangler 注入的 wasm 模块
 * 只有 `default = WebAssembly.Module`，所以从命名空间里取 default 并断言。
 * （png 是这个包里唯一带 `.wasm.d.ts` 兄弟文件的 wasm；jpeg 两个模块直接走环境声明。）
 */
const pngWasm = (pngWasmBindings as unknown as { default: WebAssembly.Module })
  .default;

/**
 * 取（或首次装配）编解码器集合。并发调用共享同一个装配 promise。
 *
 * 装配失败会清空记忆化，下一次调用重新尝试（isolate 级自愈）。
 */
export function getCodecSet(): Promise<CodecSet> {
  if (codecSetPromise) return codecSetPromise;

  const attempted = initCodecsFromModules({
    pngWasm,
    jpegDecWasm,
    jpegEncWasm,
  }).then((set) => ({
    // GIF 是纯 JS codec（omggif+gifenc），不走 wasm 装配，完成后挂载（§9-R3）
    ...set,
    gif: createGifCodec(),
  }));
  let guarded: Promise<CodecSet>;
  guarded = attempted.catch((err: unknown) => {
    // 自愈：装配失败不留毒缓存，让下一次调用（或步进重试）重新初始化。
    if (codecSetPromise === guarded) codecSetPromise = null;
    throw err;
  });
  codecSetPromise = guarded;
  return guarded;
}

/**
 * 仅测试用：清空记忆化（让下一次 `getCodecSet()` 重新装配）。
 * 生产代码不应调用；保留导出以便 workerd harness 复用同一 isolate 时复位。
 */
export function resetCodecSetForTest(): void {
  codecSetPromise = null;
}
