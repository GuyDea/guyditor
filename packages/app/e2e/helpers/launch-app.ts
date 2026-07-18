import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

export interface LaunchAppOptions {
  projectTemplate?: string;
}

export interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  projectPath?: string;
  userDataDirectory: string;
}

export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "guyditor-e2e-"));
  const userDataDirectory = join(temporaryRoot, "user-data");
  let projectPath: string | undefined;
  if (options.projectTemplate !== undefined) {
    projectPath = join(temporaryRoot, basename(options.projectTemplate));
    await cp(options.projectTemplate, projectPath, { recursive: true });
  }
  const mainEntry = resolve(import.meta.dirname, "../../dist/main/index.js");
  const launchEnvironment: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  launchEnvironment["GUYDITOR_E2E"] = "1";
  delete launchEnvironment["ELECTRON_RUN_AS_NODE"];
  const electronApp = await electron.launch({
    args: [
      mainEntry,
      `--user-data-dir=${userDataDirectory}`,
      ...(projectPath === undefined ? [] : [projectPath]),
    ],
    env: launchEnvironment,
  });
  const page = await electronApp.firstWindow();
  return {
    electronApp,
    page,
    ...(projectPath === undefined ? {} : { projectPath }),
    userDataDirectory,
  };
}
