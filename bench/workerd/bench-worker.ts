/**
 * 任务 5 / DESIGN §11-3：workerd 真环境实测基准 Worker。
 *
 * 只经 `wrangler dev` 本地运行（miniflare = 真 workerd），不部署。
 *   GET /probe                  —— 全局能力探针（ImageData / WebAssembly.compile 等）
 *   GET /bench?mp=3&kind=...    —— codec 计时（jpeg-encode/jpeg-decode/png-encode/
 *                                   png-decode/oxipng），返回 3 次迭代毫秒
 *   GET /payload?mb=40          —— commit 步在场内存模拟（整图 base64 + JSON 包裹）
 */
import { getCodecSet } from "../../src/workflow/codecs-boot";
import type { ImageDataLike } from "../../src/types";

function rawImage(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = ((x + y) * 255) / (width + height);
      data[i + 3] = 255;
    }
  }
  return data;
}

function toBase64(bytes: Uint8Array): string {
  // 分块避免 String.fromCharCode.apply 栈溢出
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function timeIt(fn: () => Promise<unknown> | unknown): Promise<number> {
  const t0 = performance.now();
  await fn();
  return Math.round((performance.now() - t0) * 10) / 10;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const codecs = await getCodecSet();

    if (url.pathname === "/probe") {
      return Response.json({
        imageDataType: typeof ImageData,
        webassemblyCompile: typeof (WebAssembly as { compile?: unknown })
          .compile,
        webassemblyInstantiateBytes: typeof WebAssembly.instantiate,
        navigator: typeof navigator,
        hardwareConcurrency:
          (globalThis as { navigator?: { hardwareConcurrency?: number } })
            .navigator?.hardwareConcurrency ?? null,
        userAgent:
          (globalThis as { navigator?: { userAgent?: string } }).navigator
            ?.userAgent ?? null,
      });
    }

    if (url.pathname === "/bench") {
      const mp = Number(url.searchParams.get("mp") ?? "3");
      const kind = url.searchParams.get("kind") ?? "jpeg-encode";
      const width = Math.round(Math.sqrt((mp * 1e6 * 4) / 3));
      const height = Math.round((mp * 1e6) / width);
      const img: ImageDataLike = {
        data: rawImage(width, height),
        width,
        height,
      };

      const times: number[] = [];
      try {
        if (kind === "jpeg-encode") {
          for (let i = 0; i < 3; i += 1) {
            times.push(
              await timeIt(() => codecs.jpeg.encode!(img, { quality: 80 })),
            );
          }
        } else if (kind === "png-encode") {
          for (let i = 0; i < 3; i += 1) {
            times.push(await timeIt(() => codecs.png!.encode(img)));
          }
        } else if (kind === "jpeg-decode") {
          const bytes = await codecs.jpeg.encode!(img, { quality: 80 });
          for (let i = 0; i < 3; i += 1) {
            times.push(await timeIt(() => codecs.jpeg.decode!(bytes)));
          }
        } else if (kind === "png-decode") {
          const bytes = await codecs.png!.encode(img);
          for (let i = 0; i < 3; i += 1) {
            times.push(await timeIt(() => codecs.png!.decode(bytes)));
          }
        } else if (kind === "oxipng") {
          const bytes = await codecs.png!.encode(img);
          for (let i = 0; i < 3; i += 1) {
            times.push(
              await timeIt(() => codecs.png!.optimizeLossless!(bytes)),
            );
          }
        } else {
          return Response.json({ error: "unknown kind" }, { status: 400 });
        }
        return Response.json({ kind, mp, width, height, timesMs: times });
      } catch (err) {
        return Response.json(
          { kind, mp, width, height, failed: String(err) },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/payload") {
      const mb = Number(url.searchParams.get("mb") ?? "20");
      const t0 = performance.now();
      try {
        const bytes = new Uint8Array(mb * 1024 * 1024).fill(7);
        const b64 = toBase64(bytes);
        const body = JSON.stringify({ contentsBase64: b64 });
        return Response.json({
          mb,
          base64Chars: b64.length,
          jsonBytes: body.length,
          ms: Math.round(performance.now() - t0),
          ok: true,
        });
      } catch (err) {
        return Response.json(
          {
            mb,
            ok: false,
            failed: String(err),
            ms: Math.round(performance.now() - t0),
          },
          { status: 500 },
        );
      }
    }

    return new TextResponse(
      "bench worker: /probe | /bench?mp&kind | /payload?mb",
    );
  },
};

function TextResponse(text: string): Response {
  return new Response(text, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
