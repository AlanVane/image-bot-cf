import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 360, height: 800 } });

test("login page fits a 360px viewport without horizontal scroll", async ({
  page,
}) => {
  await page.goto("/?preview=logged-out");
  await expect(page.locator(".login-card")).toBeVisible();

  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  expect(
    scrollWidth,
    `documentElement.scrollWidth (${scrollWidth}) exceeds viewport (${innerWidth})`,
  ).toBeLessThanOrEqual(innerWidth);
});
