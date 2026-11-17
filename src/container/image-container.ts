/**
 * Containers 兜底 Durable Object（DESIGN.md §6.3）。
 *
 * 类名 `ImageContainer` 与绑定名 `IMAGE_CONTAINER` 是编排方 wrangler.jsonc 的固定契约，
 * 勿改（containers[].class_name / durable_objects.bindings[].name）。
 *
 * 生命周期：Cloudflare 以"请求活动"计时 `sleepAfter`；长任务期间 Worker 侧每次
 * fetch 都算一次活动，够用。冷启动由 `@cloudflare/containers` 的 `startAndWaitForPorts()`
 * 在首个 fetch 里自动完成（`fetch()` 默认实现，无需手写）。
 *
 * 降级：`onError` 只记日志；真正"不炸 run"的兜底在 `oversize-client.ts`
 * （容器不可用 → `optimized: null`，调用方按跳过处理）。
 */
import { Container } from "@cloudflare/containers";

export class ImageContainer extends Container {
  /** 容器内 HTTP 服务端口（container/server.mjs 的 PORT，默认 8000）。 */
  defaultPort = 8000;
  /** 空闲 5 分钟回收；超大图是低频路径，不必常驻。 */
  sleepAfter = "5m";

  onError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[image-container] container error:", message);
  }
}
