import { expect, test } from "@playwright/test";
import { mockApi, repoCard } from "./fixtures";

test.describe("dashboard with mocked API", () => {
  test("renders repository cards with Private/Public badges", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");

    const website = repoCard(page, "acme/website");
    const handbook = repoCard(page, "acme/handbook");
    const assets = repoCard(page, "other-org/assets");

    await expect(page.locator(".repo-card")).toHaveCount(3);
    await expect(website.locator(".private-badge")).toHaveText("Private");
    await expect(handbook.locator(".public-badge")).toHaveText("Public");
    await expect(assets.locator(".private-badge")).toHaveText("Private");
    await expect(website.locator(".repo-name")).toHaveText("acme/website");
    await expect(page.locator(".account-login")).toHaveText("octocat");
  });

  test("toggle POSTs the settings change and shows the notice", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");

    const card = repoCard(page, "acme/handbook");
    const toggle = card.locator(".toggle-control");
    await expect(card.locator(".toggle-label")).toHaveText("Off");

    const posted = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/repos/acme/handbook/settings") &&
        request.method() === "POST",
    );
    await toggle.click();
    const request = await posted;

    expect(request.postDataJSON()).toEqual({ enabled: true });
    await expect(card.locator(".repo-notice")).toHaveText(
      "Optimization enabled for acme/handbook.",
    );
    await expect(card.locator(".toggle-input")).toBeChecked();
    await expect(card.locator(".toggle-label")).toHaveText("On");
  });

  test("Request new optimization POSTs and reports the queued run", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");

    const card = repoCard(page, "acme/website");
    const posted = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/repos/acme/website/optimize") &&
        request.method() === "POST",
    );
    await card
      .getByRole("button", { name: "Request new optimization" })
      .click();
    await posted;

    await expect(card.locator(".repo-notice")).toContainText(
      "Optimization queued.",
    );
    await expect(card.locator(".repo-notice")).toContainText(
      "We’ll update this repository when it’s ready.",
    );
  });

  test("coalesced optimize reports the already-in-progress copy", async ({
    page,
  }) => {
    await mockApi(page, { optimize: "coalesced" });
    await page.goto("/");

    const card = repoCard(page, "other-org/assets");
    await card
      .getByRole("button", { name: "Request new optimization" })
      .click();

    await expect(card.locator(".repo-notice")).toContainText(
      "An optimization is already in progress for this repository.",
    );
    await expect(card.locator(".repo-notice")).toContainText(
      "Your request was grouped with it.",
    );
  });

  test("settings dialog saves the default branch override via POST", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");

    const card = repoCard(page, "acme/website");
    await card.getByRole("button", { name: "Settings" }).click();

    const dialog = page.locator("dialog.settings-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".settings-label")).toHaveText(
      "Default branch override:",
    );

    const input = dialog.locator("#settings-branch");
    await input.fill("release");

    const posted = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/repos/acme/website/settings") &&
        request.method() === "POST",
    );
    await dialog.getByRole("button", { name: "Save changes" }).click();
    const request = await posted;

    expect(request.postDataJSON()).toEqual({
      defaultBranchOverride: "release",
    });
    await expect(dialog).toHaveCount(0);
    await expect(card.locator(".repo-notice")).toContainText(
      "Default branch override saved as “release”.",
    );
  });

  test("View run history expands and shows totals plus the run table", async ({
    page,
  }) => {
    await mockApi(page);
    await page.goto("/");

    const card = repoCard(page, "acme/website");
    const detail = card.locator("button.button-detail:not(.settings-button)");
    await expect(detail).toHaveText(/View run history/);
    await expect(detail).toHaveAttribute("aria-expanded", "false");
    await detail.click();

    const panel = card.locator(".stats-panel");
    await expect(panel).toBeVisible();
    await expect(detail).toHaveAttribute("aria-expanded", "true");
    await expect(detail).toHaveText(/Hide run history/);

    await expect(panel.getByText("Optimization history")).toBeVisible();
    await expect(panel.locator(".stats-total")).toHaveCount(4);
    await expect(panel.locator(".stats-total").nth(0)).toContainText("Before");
    await expect(panel.locator(".stats-total").nth(3)).toContainText("12");

    const headers = panel.locator(".history-table thead th");
    await expect(headers).toHaveText([
      "State",
      "Trigger",
      "Images",
      "Saved",
      "Created",
      "PR",
    ]);

    const firstRow = panel.locator(".history-table tbody tr").first();
    await expect(firstRow).toContainText("Done");
    await expect(firstRow).toContainText("schedule");
    await expect(firstRow).toContainText("18");

    await expect(panel.locator(".pulls-section")).toBeVisible();
    await expect(
      panel.locator('a[href="https://github.com/acme/website/pull/12"]'),
    ).toHaveCount(2);
  });
});
