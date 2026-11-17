// gifenc 是 CJS；Node ESM 具名导入经 createRequire 直读（不猜 default 互操作形状）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mod = require("gifenc");
export const GIFEncoder = mod.GIFEncoder;
export const quantize = mod.quantize;
export const applyPalette = mod.applyPalette;
export const nearestColorIndex = mod.nearestColorIndex;
export default mod;
