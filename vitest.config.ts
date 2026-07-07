import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright specs live under tests/e2e and use @playwright/test —
    // exclude them so vitest doesn't try to run them.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
  },
});
