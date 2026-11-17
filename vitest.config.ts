import { defineConfig } from "vitest/config";

// The Playwright suite (e2e/) is a separate runner: keep vitest looking only
// at the unit/API tests under tests/.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**", "e2e/**"],
  },
});
