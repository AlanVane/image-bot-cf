// Parity-locked strings (DESIGN: UX must match the original Imgbot word for
// word). These must not drift with the marketing sections, so each one is
// asserted in the state where it actually renders.
import { expect, test } from "@playwright/test";
import { deferred, mockApi, repoCard } from "./fixtures";

test("login page keeps the Sign in copy", async ({ page }) => {
  await page.goto("/?preview=logged-out");
  await expect(page.locator(".login-card")).toBeVisible();

  const signIns = page.getByRole("link", { name: "Sign in", exact: true });
  expect(await signIns.count()).toBeGreaterThan(0);
});

test("empty state keeps No installations found + Install now", async ({
  page,
}) => {
  await page.goto("/?preview=empty");
  await expect(page.getByText("No installations found")).toBeVisible();
  await expect(page.getByRole("link", { name: "Install now" })).toBeVisible();
});

test("dashboard keeps Request new optimization, Sign out and the recent-run copy", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  const card = repoCard(page, "acme/website");
  await expect(
    card.getByRole("button", { name: "Request new optimization" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeVisible();

  // Repo that has never run shows the neutral last-run sentence.
  await expect(
    repoCard(page, "other-org/assets").getByText(
      "No optimization started recently",
    ),
  ).toBeVisible();
});

test("optimize in flight shows Requesting ...", async ({ page }) => {
  const gate = deferred();
  await mockApi(page, { optimizeGate: gate.promise });
  await page.goto("/");

  const card = repoCard(page, "acme/website");
  await card.getByRole("button", { name: "Request new optimization" }).click();

  const busy = card.getByRole("button", { name: "Requesting ..." });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();

  gate.resolve();
  await expect(card.locator(".repo-notice")).toContainText(
    "Optimization queued.",
  );
});

test("settings dialog keeps Default branch override:, Cancel and Save changes", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");

  await repoCard(page, "acme/website")
    .getByRole("button", { name: "Settings" })
    .click();

  const dialog = page.locator("dialog.settings-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Default branch override:")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save changes" }),
  ).toBeVisible();

  // Cancel closes without a request.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
