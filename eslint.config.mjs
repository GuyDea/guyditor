import tseslint from "typescript-eslint";

import guyditor from "./scripts/eslint-plugin-guyditor/index.mjs";

const typescriptFiles = ["packages/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", ".fixtures/**", ".guyditor/**"],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    plugins: {
      guyditor,
    },
    rules: {
      "guyditor/no-float-time": "error",
    },
  },
);
