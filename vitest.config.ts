import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Many "unit" tests exercise real SQLite, ffmpeg, and loopback HTTP; the 5 s
    // default flakes under full-suite parallel load (observed three times).
    testTimeout: 30_000,
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["packages/*/src/**/*.contract.test.ts"],
        },
      },
      {
        test: {
          name: "golden",
          include: ["packages/render/test/golden/*.golden.test.ts"],
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: "contract",
          include: ["packages/media/src/mlworker/*.contract.test.ts"],
        },
      },
    ],
  },
});
