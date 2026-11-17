/**
 * 构建期 wasm import 的类型声明（DESIGN.md §6.2）。
 *
 * workerd 禁止运行时编译 wasm（`WebAssembly.compile` / `instantiate(bytes)` /
 * `instantiateStreaming` 全部不可用），因此编解码器只能由 wrangler 在打包时
 * 把 `.wasm` 文件编译成 `WebAssembly.Module` 再作为模块默认导出注入。
 */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
