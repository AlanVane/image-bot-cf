// Node ESM 不解析无扩展名相对导入（`./jpeg` → `./jpeg.ts`）；
// wrangler/vitest 由打包器负责，这里给 bench 脚本补同一语义。
// 另把 gifenc/omggif（CJS）重定向到具名导出 shim。
const CJS_SHIMS = {
  gifenc: new URL("./shims/gifenc.mjs", import.meta.url).href,
  omggif: new URL("./shims/omggif.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  // shim 自身对包的导入要走真实 CJS，避免重定向递归
  const fromShim = Object.values(CJS_SHIMS).includes(context.parentURL);
  if (CJS_SHIMS[specifier] && !fromShim) {
    return { url: CJS_SHIMS[specifier], shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      for (const suffix of [".ts", "/index.ts"]) {
        try {
          return await nextResolve(specifier + suffix, context);
        } catch {
          /* 继续尝试下一个后缀 */
        }
      }
    }
    throw err;
  }
}
