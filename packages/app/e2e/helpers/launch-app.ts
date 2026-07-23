import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

export interface LaunchAppOptions {
  projectTemplate?: string;
  projectPath?: string;
  userDataDirectory?: string;
  prepareUserData?: (userDataDirectory: string) => Promise<void>;
  seedOnboarding?: boolean;
}

export interface LaunchedApp {
  electronApp: ElectronApplication;
  page: Page;
  projectPath?: string;
  userDataDirectory: string;
}

export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "guyditor-e2e-"));
  const userDataDirectory = options.userDataDirectory ?? join(temporaryRoot, "user-data");
  await options.prepareUserData?.(userDataDirectory);
  let projectPath = options.projectPath;
  if (options.projectTemplate !== undefined) {
    if (projectPath !== undefined) {
      throw new Error("Launch with either projectTemplate or projectPath, not both.");
    }
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
  if (options.seedOnboarding !== false) {
    await page.evaluate(() => {
      window.localStorage.setItem("guyditor/onboarding/v1", JSON.stringify({
        schema: "onboarding/v1",
        welcomeDismissed: true,
        checklistDismissed: false,
        seenFlowOnce: false,
        checklist: {
          projectOpened: false,
          importedMedia: false,
          transcriptReady: false,
          acceptedEdit: false,
          reviewedProposal: false,
          exportedProject: false,
        },
      }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  return {
    electronApp,
    page,
    ...(projectPath === undefined ? {} : { projectPath }),
    userDataDirectory,
  };
}
