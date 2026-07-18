import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const e2eEnvironment = {
  ...process.env,
  electron_config_cache:
    process.env.electron_config_cache ?? join(tmpdir(), "guyditor-electron-cache"),
};

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", env: e2eEnvironment });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["--filter", "@guyditor/app", "build"]);

const playwright = ["pnpm", "--filter", "@guyditor/app", "test:e2e"];
if (process.platform === "linux" && !process.env.DISPLAY) {
  const xvfb = spawnSync("which", ["xvfb-run"], { encoding: "utf8" });
  if (xvfb.status !== 0) {
    console.error("test:e2e: DISPLAY is unset and xvfb-run is not installed");
    process.exit(1);
  }
  run("xvfb-run", ["-a", ...playwright]);
} else {
  run(playwright[0], playwright.slice(1));
}
