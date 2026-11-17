# image-bot-cf

An [Imgbot](https://github.com/imgbot/Imgbot)-compatible image optimization bot, rebuilt end-to-end on Cloudflare. Install it as a GitHub App: push images to your default branch and it opens — or updates in place — a single `imgbot` pull request with the lighter versions.

Optimized images mean smaller files without sacrificing quality. Lossless compression is the default.

## What it does

- Watches every installed repository for pushes that touch images or `.imgbotconfig`
- Optimizes `.png .jpg .jpeg .gif .svg` (case-insensitive) and commits the results
- Opens a single `[ImgBot] Optimize images` pull request per repository; repeated runs update that PR in place
- Honors `.imgbotconfig`: `ignoredFiles`, `minKBReduced`, `aggressiveCompression`, `compressWiki`, `schedule`, `prTitle`, `prBody` (with `{optimization_ratio}` / `{optimization_details}` magic tags)
- Optimizes `<repo>.wiki` alongside the repo when `compressWiki: true`
- Deletes the `imgbot` branch after the PR is merged; aborts politely if a human pushes to the branch
- Dashboard (GitHub OAuth) for repo toggles, default-branch override, manual "Request new optimization", and per-repo stats

The contract with every optimization: **only strictly smaller files replace the originals**, and every result is decode-validated first. When in doubt, it keeps your original.

## How it works

```
GitHub App webhook (HMAC + dedupe)
  → Queue "router" → RepoLock (Durable Object, per-repo merge/coalesce)
  → Cloudflow Workflow "optimize-run": scan tree → optimize batches
       ├─ wasm codecs in-Worker (mozjpeg/jsquash, gifenc, svgo, …)
       └─ Containers fallback for oversized images (≥8MP / ≥15MB)
  → R2 staging → GraphQL createCommitOnBranch (Verified commit)
  → PR open / in-place update
```

State lives in D1 (runs, PRs, image cache, sessions), bytes live in R2 with TTL cleanup, and a 30-minute cron sweeps for stuck PRs. Everything deploys as one Worker: `npx wrangler deploy` builds the container image and ships the API + dashboard together.

## .imgbotconfig

Place it at the repository root (all fields optional):

```json
{
  "schedule": "daily",
  "ignoredFiles": ["docs/**/*.png"],
  "aggressiveCompression": false,
  "compressWiki": true,
  "minKBReduced": 10,
  "prTitle": "chore: compress images",
  "prBody": "Saved {optimization_ratio}\n{optimization_details}"
}
```

- `schedule`: `daily` | `weekly` | `monthly` — periodic re-optimization
- `ignoredFiles`: glob patterns (case-insensitive), `*` does not cross `/`
- `minKBReduced`: minimum total KB saved to open/update a PR (default 10; `0` or `null` = no threshold)
- `aggressiveCompression`: switch JPEG/PNG/GIF to lossy variants

## Development

```bash
npm install
npm run typecheck && npm test     # 377 tests
npm run dev                       # wrangler dev (needs .dev.vars, see .dev.vars.example)
npm run db:local                  # apply db/schema.sql to local D1
```

Benchmarks: `cd bench && node generate-corpus.mjs && node run-corpus.mjs` (20-image corpus, results in `bench/RESULTS.md`).

Real-repo end-to-end verification (maintainers): push a `.imgbotconfig` change or an image to a repo with the App installed, then inspect the run via `wrangler d1 execute image-bot-db --remote` and `wrangler workflows instances describe optimize-run <run_id>`. An empty diff is filtered by design — that is idempotency, not a bug.

## Self-hosting

1. Create a GitHub App: repository permissions **Contents: read & write**, **Pull requests: read & write**, **Metadata: read**; subscribe to `push`, `pull_request`, `installation`, `installation_repositories`; generate a webhook secret and a PKCS#1 private key; enable OAuth credentials for the dashboard.
2. Copy `.dev.vars.example` → `.dev.vars` for local work; set remote secrets with `npx wrangler secret put <NAME>` (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`). Set `GITHUB_APP_SLUG` in `wrangler.jsonc` `vars` for the dashboard/PR install link. Optional: `QUOTA_DAILY_RUNS` caps runs started per installation per UTC day (`0` = unlimited).
3. `npx wrangler deploy` — also builds the `container/` Docker image used for oversized images.
4. Point the App's webhook at `https://<your-domain>/api/hook`.

Note: a Workflow instance pins the code version at creation — right after a deploy, wait ~1 minute before triggering runs.

## Documentation map

- [DESIGN.md](DESIGN.md) — full design spec, original-behavior contract, risk register (中文)
- [AGENTS.md](AGENTS.md) — agent/dev guide and hard-won gotchas (中文)
- [LICENSES.md](LICENSES.md) — third-party component licenses
- `bench/RESULTS.md` — compression benchmark vs the original toolchain

## Credits

Behavior and UX parity with [Imgbot](https://github.com/imgbot/Imgbot) by [dabutvin](https://github.com/dabutvin) and contributors (MIT). This is an independent rebuild on Cloudflare, not affiliated with the original.

## License

MIT — see [LICENSE](LICENSE). Third-party components and their full license texts: [LICENSES.md](LICENSES.md) (compliance rationale & decisions) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

This product includes software developed by the Independent JPEG Group (`jpegtran`/MozJPEG lineage via `@jsquash/jpeg`).
