# Privacy Policy — Image-Bot-CF

**Effective date:** 2026-11-18

Image-Bot-CF ("the App") is a GitHub App that compresses images in your
repositories and opens pull requests with the optimized files. This policy
explains what information the App collects, how it is used, how long it is
kept, and what choices you have. It applies to the GitHub App, its webhooks,
and the dashboard at `https://imgbot.alanpally.com`.

## Information we collect

**GitHub identity (dashboard sign-in only).** When you sign in to the
dashboard, we authenticate through GitHub OAuth and receive only your GitHub
**username** and numeric **account ID**. We request no OAuth scopes beyond
this basic identity. We do not receive your email address, profile details,
or private account data through this flow.

**Installation and repository metadata.** When you install the App, we record
the installation ID, the owning account's login and type (User or
Organization), the names of the repositories you enable, their default
branches, and per-repository configuration you set (such as a custom default
branch or skip rules).

**Run history.** For each optimization run we store its trigger, state,
timestamps, the number of images processed, before/after byte totals, related
pull request numbers and their state, and error messages when a run fails.

**Image content (transient).** To do its job the App downloads image files
from the repositories it is installed on and processes them in memory. While
a run is in progress, optimized candidates may be staged temporarily in
Cloudflare R2 storage and are deleted when the run completes. We do not keep
your image files long-term; we retain only cryptographic hashes and file
sizes (used to skip unchanged images) in the optimization cache.

**Marketplace purchase events.** If the App is installed through GitHub
Marketplace, GitHub sends us purchase state changes (new purchase, upgrade,
downgrade, cancellation). We store the account ID, account login, plan name,
and current state so the App can apply plan limits.

**Webhook delivery records.** We keep webhook delivery IDs and event types
for operational tracing. We do not store webhook payload bodies beyond what
is needed to process the events described above.

**Session data.** Dashboard sessions use an opaque session cookie
(`ib_session`) that contains only a random session ID. GitHub access and
refresh tokens are stored server-side only (AES-256-GCM encrypted when an
encryption key is configured) and are never placed in cookies or exposed to
the browser.

**Server logs.** Like any web service, our hosting platform (Cloudflare)
records standard operational logs such as request timestamps and error
traces, used for debugging and abuse prevention.

## How we use information

We use the information solely to operate and improve the App: to detect image
changes, compress images, open pull requests in your repositories, display
run history in the dashboard, enforce plan limits, prevent abuse, and debug
failures. We do not use your repository content for advertising, analytics,
or to train machine learning models.

## Retention

| Data                                        | Retention                                                          |
| ------------------------------------------- | ------------------------------------------------------------------ |
| Staged image files (R2)                     | Deleted when the run completes                                     |
| Dashboard sessions and tokens               | 7 days (deleted automatically on expiry; also removed on sign-out) |
| Webhook delivery records                    | 30 days                                                            |
| Debug/error captures                        | 90 days                                                            |
| Image optimization cache (hashes and sizes) | 180 days                                                           |
| Run history and pull request metadata       | 365 days                                                           |

Installation and repository configuration is kept until you uninstall the
App or delete the data on request (see below).

## Sharing

We do not sell or rent your information, and we do not share it with
third-party advertisers or analytics providers. Data is processed by:

- **GitHub** — as the platform the App integrates with; your images are read
  from and written back to GitHub repositories you control.
- **Cloudflare** — as the infrastructure provider that hosts the service
  (compute, D1 database, and transient object storage).

Each processes data under its own terms of service and privacy policy.

## Cookies

The dashboard uses only two cookies: the session cookie (`ib_session`) and a
short-lived OAuth anti-forgery cookie (`ib_oauth_state`, expires within 30
minutes). Both are `HttpOnly`, `Secure`, and `SameSite=Lax`. We set no
tracking or advertising cookies.

## Security

All traffic is over HTTPS. GitHub access tokens are stored server-side and
encrypted at rest when an encryption key is configured; the App uses
least-privilege OAuth (basic identity only for the dashboard) and per-install
GitHub App tokens scoped to the repositories you select. No system is
perfectly secure, but we follow current best practices and review access
regularly.

## Your choices and rights

- **Uninstall the App** at any time from your GitHub settings. This stops all
  further access to your repositories.
- **Sign out of the dashboard** deletes your session and tokens immediately.
- **Request access to, correction of, or deletion of** the data we hold about
  you or your account (installation records, run history, sessions), and we
  will comply within a reasonable period.
- Your repository's images remain yours at all times; the App only proposes
  changes to them through pull requests you can accept or reject.

To exercise any of these rights, contact us using the channel below.

## Children's privacy

The App is not directed at children under 16, and we do not knowingly collect
personal information from them.

## Changes to this policy

We may update this policy as the service evolves. Material changes will be
reflected with a new effective date on this page. Continued use of the App
after changes take effect constitutes acceptance of the revised policy.

## Contact

- Support and privacy requests: <https://github.com/AlanVane/image-bot-cf/issues>
- Security vulnerabilities: please report privately as described in
  [SECURITY.md](https://github.com/AlanVane/image-bot-cf/blob/main/SECURITY.md)
