/**
 * jpegtran `-optimize -copy none` 的 wasm 接入（任务 2 / DESIGN §11-2）。
 *
 * 产物由 `tools/jpegtran-wasm/build.sh`（Docker + emscripten，IJG jpegsrc 10）
 * 构建后 vendored 进 `vendor/`，**不要手改 vendor 文件**。
 *
 * §6.2 约束：wasm 由宿主构建期 import 成 `WebAssembly.Module` 注入；
 * emscripten 胶水的默认加载路径（fetch/compile(bytes)）被 `instantiateWasm`
 * 钩子完全绕开——只走 `WebAssembly.instantiate(Module, imports)`（合法）。
 *
 * 语义：DCT 系数域透传 + Huffman 表重优化（`optimize_coding=TRUE`），
 * 不解码像素 → 严格无损；标记段不拷贝（元数据剥离另有 `stripJpegMetadata`）。
 */
import type { CodecSet } from "../types";

// emscripten MODULARIZE 胶水无类型声明
// @ts-expect-error -- vendor/jpegtran_opt.mjs 是构建产物（emscripten 胶水）
import createJpegOptModule from "./vendor/jpegtran_opt.mjs";

type JpegOptModule = {
  cwrap: (
    name: string,
    ret: string,
    args: string[],
  ) => (...args: number[]) => number;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
};

export type HuffmanOptimizer = (bytes: Uint8Array) => Uint8Array | null;

/**
 * 装配 Huffman 重优化器。失败返回 null 的情形：损坏/非 JPEG 输入（C 侧
 * setjmp 兜底返回错误码，绝不 trap）。
 */
export async function createHuffmanOptimizer(
  wasmModule: WebAssembly.Module,
): Promise<HuffmanOptimizer> {
  const mod = (await createJpegOptModule({
    instantiateWasm: async (
      imports: WebAssembly.Imports,
      success: (
        instance: WebAssembly.Instance,
        module: WebAssembly.Module,
      ) => void,
    ) => {
      const instance = await WebAssembly.instantiate(wasmModule, imports);
      success(instance, wasmModule);
      return instance.exports;
    },
  })) as JpegOptModule;

  const run = mod.cwrap("jpeg_optimize_huffman", "number", [
    "number",
    "number",
    "number",
    "number",
  ]);

  return (bytes: Uint8Array): Uint8Array | null => {
    const inPtr = mod._malloc(bytes.length);
    const outPtrPtr = mod._malloc(4);
    const outLenPtr = mod._malloc(4);
    let outPtr = 0;
    try {
      mod.HEAPU8.set(bytes, inPtr);
      const rc = run(inPtr, bytes.length, outPtrPtr, outLenPtr);
      if (rc !== 0) return null;
      outPtr = mod.HEAPU32[outPtrPtr >> 2]!;
      const outLen = mod.HEAPU32[outLenPtr >> 2]!;
      if (outLen <= 0) return null;
      return mod.HEAPU8.slice(outPtr, outPtr + outLen);
    } finally {
      if (outPtr !== 0) mod._free(outPtr);
      mod._free(inPtr);
      mod._free(outPtrPtr);
      mod._free(outLenPtr);
    }
  };
}

/** §6.1 契约：挂到 `CodecSet.jpeg.reoptimizeHuffman`。 */
export type JpegHuffmanCodec = NonNullable<
  CodecSet["jpeg"]
>["reoptimizeHuffman"];
