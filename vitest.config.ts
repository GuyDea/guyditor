import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
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
