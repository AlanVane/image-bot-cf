/**
 * 容器通道的硬上限（DESIGN.md §6.3）。
 *
 * 只放**无依赖的纯常量**：Worker 侧（`oversize-client.ts` / workflow 编排）共用同一数字，
 * 避免调用方与客户端两侧漂移。容器内是纯 JS（`container/server.mjs`），不能 import TS，
 * 那里的同名常量靠注释标注"与 limits.ts 同步"。
 */

/**
 * 送进容器的单张图字节上限（40MB）。
 *
 * 超过即视为"容器也救不了"：既不构造 base64 请求（~1.33× 膨胀），也不冒容器 OOM 的风险，
 * 调用方直接按 `too_large` 跳过。这是**硬上限**，与 dispatch 的 15MB / 8MP 软降级闸门
 * （§6.2，Worker 内存墙）分工不同：那边是"WASM 跑不动 → 试试容器"，这里是"容器也别试"。
 */
export const MAX_CONTAINER_INPUT_BYTES = 40 * 1024 * 1024;
