# workerd 真环境实测（任务 5 / DESIGN §11-3）

日期:2026-11-17。方式:`bench/workerd/` 迷你 Worker 经 `npx wrangler dev` 在**真 workerd**
上运行(与 Node V8 基准区分),脚本见 `bench/workerd/bench-worker.ts`。

复现:

```bash
cd bench/workerd && npx wrangler dev --port 8799 &
curl http://127.0.0.1:8799/probe
curl "http://127.0.0.1:8799/bench?mp=8&kind=jpeg-encode"
curl "http://127.0.0.1:8799/payload?mb=80"
```

## 全局能力探针

| 项                                    | 结果                                                                         |
| :------------------------------------ | :--------------------------------------------------------------------------- |
| `typeof ImageData`                    | **`function`**（全局存在 → jsquash 解码无需 shim；`ImageDataLike` 解耦保留） |
| `WebAssembly.compile` / `instantiate` | 存在为函数（调用仍被 workerd 运行时策略禁止,§6.2 约束不变）                  |
| `navigator.hardwareConcurrency`       | 1（印证 oxipng 钉单线程 pkg 正确）                                           |
| `navigator.userAgent`                 | `Cloudflare-Workers`                                                         |

## codec 计时(单线程,3 次迭代,毫秒)

| kind              |            3MP |            8MP | 折算                                                      |
| :---------------- | -------------: | -------------: | :-------------------------------------------------------- |
| jpeg-encode (q80) |    427/383/374 |    972/979/985 | ≈120ms/MP(与 Node 基准 ~130ms/MP 吻合)                    |
| jpeg-decode       |       47/37/36 |       96/98/97 | ≈12ms/MP                                                  |
| png-encode        |       56/40/37 |      103/94/91 | ≈12ms/MP                                                  |
| png-decode        |       53/42/42 |       96/93/96 | ≈12ms/MP                                                  |
| oxipng (level 2)  | 4849/2705/2657 | 8525/8534/8475 | ≈1ms/像素量级;批量步需计入(10 图×8.5s=85s/步,5min 预算内) |

结论:**8MP 边界(§6.2 守卫值)在 5min/步 CPU 预算内无压力**;oxipng 是最重项,
`optimize-batch` 块大小(≤10 图)已足够安全。

## commit 载荷探针(oracle P2-7 观测项)

| 输入 | base64+JSON 在场内存 | 结果 |   耗时 |
| ---: | -------------------: | :--- | -----: |
| 20MB |                ≈56MB | ok   |  763ms |
| 40MB |               ≈112MB | ok   | 1478ms |
| 80MB |               ≈224MB | ok   | 3039ms |

**注意**:`wrangler dev` 本地 workerd 不执行生产 128MB 隔离墙,以上"存活"只证明
CPU 侧可行;**prod 巨仓的内存/载荷风险仍在**(每 run 全量重放 = O(总 PR 字节),
oracle P2-7 建议的每 PR 字节/图数上限未实施,维持观测)。

## 后续

- §11-3 关闭;`ImageData` shim 分支从规划中移除。
- oxipng 的 CPU 成本已在 §6.1 基准表登记。
