# Security policy

## Supported versions

The `main` branch is the only supported line. Fixes land on `main` via pull requests with CI (typecheck, unit tests, frontend e2e) required to pass.

## Reporting a vulnerability

Please report security issues **privately** through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab → **Report a vulnerability**.
2. Describe the issue, affected component, and reproduction steps.

If private reporting is unavailable, open a GitHub issue with minimal detail asking for a private contact channel — do not include exploit details in public issues.

We aim to acknowledge reports within **72 hours** and to publish a fix or mitigation timeline within **90 days** of disclosure (coordinated disclosure; earlier is welcome).

## What is in scope

- The deployed worker at `imgbot.alanpally.com` (dashboard, OAuth flow, REST API)
- The GitHub App integration surface: webhook handling (`/api/hook`), installation-token usage, commit/PR creation
- The optimization pipeline (image decoding/encoding paths, container fallback)
- Secrets handling in this repository's code and configuration templates

## Security model notes

For reviewers and reporters, the current posture:

- **Webhook**: HMAC-SHA256 signature verification is mandatory; deliveries are deduplicated and enqueued before the dedupe record is written (a failed enqueue can be retried by GitHub).
- **Sessions**: OAuth user tokens live server-side in D1 only (cookies carry an opaque session id, `HttpOnly; Secure; SameSite=Lax`). Tokens are AES-GCM encrypted at rest when `SESSION_ENCRYPTION_KEY` is configured; near-expiry tokens are rotated via refresh tokens; dead tokens end the session.
- **CSRF/state**: OAuth `state` double-submit; logout and other state-changing API calls require `POST` with a same-origin `Origin` check when the header is present.
- **Responses**: uniform security headers (CSP with strict `script-src`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`) on both worker and static-asset responses.
- **Commits**: created through GitHub's signed-commit path (`createCommitOnBranch`) — the green **Verified** badge is GitHub's own signature, not a key held by this service.
- **Least privilege**: the GitHub App requests Contents: read & write, Pull requests: read & write, Metadata: read. Repository visibility checks use the _user's_ token; repository writes use _installation_ tokens; app-level lookups use the app JWT.
- **Resource limits**: hard ceilings on image bytes (worker 15MB/8MP guards; container input 40MB), per-PR payload budget (500 images / 10MB), per-installation daily run quota (optional, `QUOTA_DAILY_RUNS`), and data retention pruning (sessions/deliveries/runs/cache/dead letters).

## Out of scope

- Denial-of-service against Cloudflare/GitHub infrastructure
- Social-engineering attacks against repository owners or GitHub support
- Issues in upstream dependencies without a practical exploit path in this project
- Reports generated purely by automated scanners without a demonstrated impact
