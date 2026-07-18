import tseslint from "typescript-eslint";

import guyditor from "../../scripts/eslint-plugin-guyditor/index.mjs";

const sourceFiles = ["src/**/*.{ts,tsx}"];

export default tseslint.config(
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: sourceFiles,
  })),
  {
    files: sourceFiles,
    plugins: { guyditor },
    rules: {
      "guyditor/no-float-time": "error",
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "@guyditor/render is local-only; fetch is forbidden by Part 12 §12.1.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "http",
            "node:http",
            "https",
            "node:https",
            "net",
            "node:net",
            "dgram",
            "node:dgram",
          ],
          patterns: [
            "http/*",
            "node:http/*",
            "https/*",
            "node:https/*",
            "net/*",
            "node:net/*",
            "dgram/*",
            "node:dgram/*",
          ],
        },
      ],
    },
  },
);
