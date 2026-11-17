// omggif 是 CJS；Node ESM 具名导入经 createRequire 直读。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mod = require("omggif");
export const GifReader = mod.GifReader;
export const GifWriter = mod.GifWriter;
export default mod;
