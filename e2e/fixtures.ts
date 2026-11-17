// Fixtures + API mocking for the static frontend.
//
// The dashboard SPA (public/app.js) talks to a same-origin JSON API. Every
// spec installs `mockApi(page)` which intercepts `**/api/**` and answers from
// the fixtures below, so the suite runs headless with no backend at all.
import type { Page, Route } from "@playwright/test";

export type RepoFixture = {
  fullName: string;
  isPrivate: boolean;
  enabled: boolean;
  installationId: number;
  lastRunAt: string | null;
  lastRunState: string | null;
  totalSavedBytes: number;
  prCount: number;
  defaultBranchOverride: string | null;
};

export const USER = {
  login: "octocat",
  userId: 1042,
  installUrl: "https://github.com/apps/imgbot/installations/new",
};

export const DEFAULT_REPOS: RepoFixture[] = [
  {
    // Private + enabled + recent run.
    fullName: "acme/website",
    isPrivate: true,
    enabled: true,
    installationId: 42,
    lastRunAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    lastRunState: "done",
    totalSavedBytes: 2_516_582,
    prCount: 4,
    defaultBranchOverride: null,
  },
  {
    // Public + disabled: the toggle test flips this one on.
    fullName: "acme/handbook",
    isPrivate: false,
    enabled: false,
    installationId: 42,
    lastRunAt: "2026-11-10T08:30:00.000Z",
    lastRunState: "skipped_no_images",
    totalSavedBytes: 0,
    prCount: 0,
    defaultBranchOverride: "docs",
  },
  {
    // Second installation, never run: drives "No optimization started recently".
    fullName: "other-org/assets",
    isPrivate: true,
    enabled: true,
    installationId: 77,
    lastRunAt: null,
    lastRunState: null,
    totalSavedBytes: 84_312,
    prCount: 1,
    defaultBranchOverride: null,
  },
];

export const STATS = {
  totals: {
    bytesBefore: 9_400_000,
    bytesAfter: 6_883_418,
    savedKb: 2460,
    runs: 12,
  },
  recentRuns: [
    {
      state: "done",
      trigger: "schedule",
      imagesOptimized: 18,
      savedKb: 312,
      createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      prNumber: 12,
    },
    {
      state: "skipped_no_changes",
      trigger: "webhook",
      imagesOptimized: 0,
      savedKb: 0,
      createdAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
      prNumber: null,
    },
  ],
  pulls: [
    {
      prNumber: 12,
      state: "open",
      openedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      closedAt: null,
    },
    {
      prNumber: 9,
      state: "merged",
      openedAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
      closedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
    },
  ],
};

export type Deferred = { promise: Promise<void>; resolve: () => void };

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type MockOptions = {
  /** Answer /api/me with 401, exercising the logged-out flip. */
  loggedOut?: boolean;
  /** Answer the next N /api/me calls with a 500, then succeed (retry path). */
  meFailures?: number;
  /** Repos served by /api/repos (mutated in place as the app saves). */
  repos?: RepoFixture[];
  /** Response shape for a repo optimize request. */
  optimize?: "started" | "coalesced";
  /** Gate the optimize response so specs can observe the busy label. */
  optimizeGate?: Promise<void>;
  /** Called with every mocked request, useful for asserting payloads. */
  onRequest?: (info: {
    method: string;
    pathname: string;
    body: unknown;
    search: string;
  }) => void;
};

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

/**
 * Install the API mock for a page. Returns the live repo fixtures so a spec
 * can assert on server-side state after a UI action.
 */
export async function mockApi(page: Page, options: MockOptions = {}) {
  const repos = (options.repos ?? DEFAULT_REPOS).map((repo) => ({ ...repo }));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() ?? null;
    options.onRequest?.({ method, pathname, body, search: url.search });

    if (pathname === "/api/me") {
      if (options.loggedOut) return json(route, 401, { error: "unauthorized" });
      if (options.meFailures && options.meFailures > 0) {
        options.meFailures -= 1;
        return json(route, 500, { error: "internal_error" });
      }
      return json(route, 200, USER);
    }

    if (pathname === "/api/repos" && method === "GET") {
      return json(route, 200, repos);
    }

    const match = pathname.match(
      /^\/api\/repos\/([^/]+)\/([^/]+)\/(settings|optimize|stats)$/,
    );
    if (match) {
      const fullName = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
      const action = match[3];
      const repo = repos.find((item) => item.fullName === fullName);
      if (!repo) return json(route, 404, { error: "not_found" });

      if (action === "settings" && method === "POST") {
        const patch = (body ?? {}) as Partial<RepoFixture>;
        if (typeof patch.enabled === "boolean") repo.enabled = patch.enabled;
        if ("defaultBranchOverride" in patch) {
          repo.defaultBranchOverride =
            (patch.defaultBranchOverride as string | null) ?? null;
        }
        return json(route, 200, repo);
      }

      if (action === "optimize" && method === "POST") {
        if (options.optimizeGate) await options.optimizeGate;
        if (options.optimize === "coalesced") {
          return json(route, 202, {
            runId: "run_coalesced",
            started: false,
            coalesced: true,
          });
        }
        return json(route, 202, {
          runId: "run_20261118",
          started: true,
          coalesced: false,
        });
      }

      if (action === "stats" && method === "GET") {
        if (fullName === "acme/handbook") {
          return json(route, 200, {
            totals: { bytesBefore: 0, bytesAfter: 0, savedKb: 0, runs: 0 },
            recentRuns: [],
            pulls: [],
          });
        }
        return json(route, 200, STATS);
      }
    }

    // Auth endpoints are same-origin navigations; keep the page from leaving
    // the SPA by answering with a stub document.
    if (pathname === "/api/auth/login") {
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><title>GitHub stub</title><p>GitHub stub</p>",
      });
    }
    if (pathname === "/api/auth/logout") {
      return json(route, 200, { ok: true });
    }

    return json(route, 404, { error: "not_found" });
  });

  return repos;
}

/** Convenience selector for a repo card by full name. */
export function repoCard(page: Page, fullName: string) {
  return page.locator(`article.repo-card[data-repo="${fullName}"]`);
}
