import { spawn } from "node:child_process";

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const executable = process.platform === "win32" ? "electron-vite.cmd" : "electron-vite";
const child = spawn(executable, ["dev"], {
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`dev: could not start electron-vite: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 0);
});
