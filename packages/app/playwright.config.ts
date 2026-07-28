import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./dist/test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // AC specs drive real ffmpeg exports through the built Electron app; AC-001
  // measures 30.1 s on an idle machine, so a 30 s budget failed whenever the
  // suite ran chained behind the golden renders (three observed occurrences).
  // Retries stay at 0 — the budget was wrong, the tests are not flaky.
  timeout: 120_000,
  expect: { timeout: 5_000 },
  reporter: [["list"]],
});
