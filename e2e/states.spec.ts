import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mockApi } from "./fixtures";

const ALL_CAPS_SENTENCE = /\b[A-Z][A-Z0-9]{1,}\b(?:\s+[A-Z][A-Z0-9]{1,}\b){2,}/;

async function expectNoAllCapsSentences(page: Page) {
  const text = await page.locator("body").innerText();
  const match = text.match(ALL_CAPS_SENTENCE);
  expect(
    match,
    `body text contains an all-caps shout: ${JSON.stringify(match?.[0])}`,
  ).toBeNull();
}

test("empty preview shows the empty state with Install now", async ({
  page,
}) => {
  await page.goto("/?preview=empty");

  await expect(page.getByText("No installations found")).toBeVisible();
  await expect(page.getByRole("link", { name: "Install now" })).toBeVisible();
  await expectNoAllCapsSentences(page);
});

test("error preview shows a retry affordance", async ({ page }) => {
  await page.goto("/?preview=error");

  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expectNoAllCapsSentences(page);
});

test("retry after a transient API failure recovers the workspace", async ({
  page,
}) => {
  // First /api/me fails, the retry gets through: the error state must be able
  // to return to the dashboard without a reload.
  await mockApi(page, { meFailures: 1 });
  await page.goto("/");

  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expectNoAllCapsSentences(page);

  await retry.click();
  await expect(page.locator(".repo-card")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});
