/**
 * 测试宿主（Node/vitest）侧的 wasm 与夹具装载。
 *
 * workerd 禁止运行时编译 wasm（DESIGN.md §6.2），workers-types 因此不提供
 * `WebAssembly.compile`、且 `WebAssembly.Module` 标为 abstract；Node 运行时两者皆有。
 * 此处一次性放宽类型，路径统一从 tests/ 解析（本文件所在目录）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasmCompile = (
  WebAssembly as unknown as {
    compile(bytes: BufferSource): Promise<WebAssembly.Module>;
  }
).compile;

const resolve = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url).href);

export function loadWasmModule(
  relativePath: string,
): Promise<WebAssembly.Module> {
  return wasmCompile(new Uint8Array(readFileSync(resolve(relativePath))));
}

export function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(`./fixtures/${name}`)));
}
