import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test.describe("logged-out login page", () => {
  test("renders hero and login card with the Sign in contract copy", async ({
    page,
  }) => {
    await page.goto("/?preview=logged-out");

    await expect(page.locator(".login-story")).toBeVisible();
    await expect(page.locator(".login-card")).toBeVisible();
    await expect(page.locator(".login-card h2")).toBeVisible();
    await expect(page.locator("h1")).not.toBeEmpty();
    // Contract copy: every entry point into GitHub says "Sign in".
    await expect(page.locator(".login-button")).toContainText("Sign in");
  });

  test("CTA flips to instant busy feedback without leaving the page", async ({
    page,
  }) => {
    // A 204 answer keeps Chromium on the current document: the navigation is
    // acknowledged but nothing replaces the SPA, so the busy label stays put.
    await page.route("**/api/auth/login", (route) =>
      route.fulfill({ status: 204, body: "" }),
    );

    await page.goto("/?preview=logged-out");
    const cta = page.locator(".login-button");
    await cta.click();

    await expect(cta).toHaveText("Opening GitHub…");
    await expect(cta).toHaveAttribute("aria-busy", "true");
    // The page did not navigate away: the card is still on screen.
    await expect(page.locator(".login-card")).toBeVisible();
  });

  test("401 from /api/me flips the dashboard to the login page", async ({
    page,
  }) => {
    await mockApi(page, { loggedOut: true });
    await page.goto("/");

    await expect(page.locator(".login-card")).toBeVisible();
    await expect(page.locator(".login-button")).toContainText("Sign in");
    await expect(page.locator(".app-header")).toHaveCount(0);
  });
});
