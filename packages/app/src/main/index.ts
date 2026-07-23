import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import type { IpcMainInvokeEvent, Session } from "electron";
import {
  EphemeralCredentialStore,
  SafeStorageCredentialStore,
} from "../../../agent/src/index.js";

import type { IpcRequest, IpcResponse, ServiceName } from "../shared/ipc.js";
import { WindowEventPublisher } from "./events.js";
import { StructuredLogger } from "./logger.js";
import { createRpcDispatcher } from "./rpc.js";
import { AppServiceHost } from "./service-host.js";
import type { WindowServiceHost } from "./service-host.js";
import { DEFAULT_SETTINGS, loadSettings } from "./settings.js";
import type { UserSettings } from "./settings.js";
import { IPC_SURFACES } from "./surfaces.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const serviceNames = new Set<ServiceName>(IPC_SURFACES.map(({ service }) => service));
const lockedSessions = new WeakSet<Session>();
const windowHosts = new Map<number, WindowServiceHost>();
let appHost: AppServiceHost | undefined;
let shuttingDown = false;

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const isolatedUserData = argumentValue("--user-data-dir");
if (isolatedUserData !== undefined) {
  const isolatedPath = resolve(isolatedUserData);
  mkdirSync(isolatedPath, { recursive: true });
  app.setPath("userData", isolatedPath);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

interface StartupState {
  crashMarker: string;
  crashCountPath: string;
  logger: StructuredLogger;
  safeMode: boolean;
  settings: UserSettings;
  userDirectory: string;
}

function appUserDirectory(): string {
  return isolatedUserData === undefined
    ? join(homedir(), ".guyditor")
    : join(resolve(isolatedUserData), ".guyditor");
}

async function prepareStartup(): Promise<StartupState> {
  const userDirectory = appUserDirectory();
  const stateDirectory = join(userDirectory, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const crashMarker = join(stateDirectory, "crash.marker");
  const crashCountPath = join(stateDirectory, "crash-count.json");
  const recoveryNeeded = existsSync(crashMarker);
  let previousCount = 0;
  try {
    const value = JSON.parse(readFileSync(crashCountPath, "utf8")) as unknown;
    previousCount = typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
  } catch {
    previousCount = 0;
  }
  const crashCount = recoveryNeeded ? previousCount + 1 : 0;
  writeFileSync(crashCountPath, `${JSON.stringify(crashCount)}\n`, { mode: 0o600 });
  writeFileSync(crashMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });

  const bootstrapLogger = new StructuredLogger(
    userDirectory,
    DEFAULT_SETTINGS.logging.retentionDays,
  );
  const loaded = await loadSettings(userDirectory);
  const logger = loaded.settings.logging.retentionDays === DEFAULT_SETTINGS.logging.retentionDays
    ? bootstrapLogger
    : new StructuredLogger(
      userDirectory,
      loaded.settings.logging.retentionDays,
    );
  const runtimeManifestHash = createHash("sha256").update(JSON.stringify({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  })).digest("hex");
  logger.write({
    level: "info",
    scope: "app",
    event: "app.start",
    msg: "Guyditor is starting.",
    data: { version: app.getVersion(), runtimeManifestHash, recoveryNeeded },
  });
  if (loaded.warning !== undefined) {
    logger.write({
      level: "warn",
      scope: "settings",
      event: "settings.recovered",
      msg: loaded.warning,
      data: loaded.recoveredPath === undefined ? {} : { recoveredPath: loaded.recoveredPath },
    });
  }
  return {
    crashMarker,
    crashCountPath,
    logger,
    safeMode: crashCount >= 2 || process.argv.includes("--safe-mode"),
    settings: loaded.settings,
    userDirectory,
  };
}

const startupPromise = hasSingleInstanceLock ? prepareStartup() : undefined;

function isIpcRequest(value: unknown): value is IpcRequest {
  return typeof value === "object" && value !== null &&
    "v" in value && value.v === 1 &&
    "requestId" in value && typeof value.requestId === "string" &&
    /^req_[a-z2-7]{10}$/u.test(value.requestId) &&
    "service" in value && typeof value.service === "string" &&
    serviceNames.has(value.service as ServiceName) &&
    "method" in value && typeof value.method === "string" &&
    "params" in value;
}

function malformedResponse(value: unknown): IpcResponse {
  const requestId = typeof value === "object" && value !== null &&
    "requestId" in value && typeof value.requestId === "string"
    ? value.requestId
    : "req_aaaaaaaaaa";
  return {
    v: 1,
    requestId,
    ok: false,
    error: {
      code: "E_IPC_SCHEMA",
      message: "The gd:rpc request envelope is invalid.",
      affected: [],
      acceptedStateChanged: false,
      retry: "none",
    },
  };
}

function hostForEvent(event: IpcMainInvokeEvent): WindowServiceHost | undefined {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window === null ? undefined : windowHosts.get(window.id);
}

function registerIpc(): void {
  ipcMain.handle("gd:rpc", async (event, request: unknown) => {
    if (!isIpcRequest(request)) return malformedResponse(request);
    const host = hostForEvent(event);
    if (host === undefined) {
      return {
        v: 1,
        requestId: request.requestId,
        ok: false,
        error: {
          code: "E_IPC_WINDOW",
          message: "The calling window has no service host.",
          affected: [],
          acceptedStateChanged: false,
          retry: "none",
        },
      } satisfies IpcResponse;
    }
    return createRpcDispatcher(IPC_SURFACES, (service) => host.resolveService(service))(request);
  });
}

function rendererDevelopmentOrigin(): string | undefined {
  const value = process.env["ELECTRON_RENDERER_URL"];
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function lockRendererNetwork(session: Session): void {
  if (lockedSessions.has(session)) return;
  lockedSessions.add(session);
  const developmentOrigin = rendererDevelopmentOrigin();
  session.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    let allowed = details.url.startsWith("devtools://");
    if (developmentOrigin !== undefined) {
      try {
        allowed ||= new URL(details.url).origin === developmentOrigin;
      } catch {
        allowed = false;
      }
    }
    callback({ cancel: !allowed });
  });
}

function projectPathFromArgv(argv: readonly string[]): string | undefined {
  for (const argument of argv) {
    if (argument.startsWith("-") || !existsSync(argument)) continue;
    const candidate = resolve(argument);
    if (existsSync(join(candidate, "episode.guyditor.yaml"))) return candidate;
  }
  return undefined;
}

async function createWindow(initialProjectPath?: string): Promise<BrowserWindow> {
  const host = appHost;
  if (host === undefined) throw new Error("Application services are not initialized.");
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 800,
    minHeight: 560,
    show: false,
    title: "Guyditor",
    backgroundColor: "#12171c",
    webPreferences: {
      preload: join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  lockRendererNetwork(window.webContents.session);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const publisher = new WindowEventPublisher((channel, payload) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  });
  const windowHost = host.createWindowHost({
    publisher,
    chooseProject: async () => {
      const selected = await dialog.showOpenDialog(window, {
        title: "Open Guyditor project",
        buttonLabel: "Open project",
        properties: ["openDirectory"],
      });
      return selected.canceled ? undefined : selected.filePaths[0];
    },
    chooseMedia: async () => {
      const selected = await dialog.showOpenDialog(window, {
        title: "Import media",
        buttonLabel: "Import",
        properties: ["openFile", "multiSelections"],
      });
      return selected.canceled ? [] : selected.filePaths;
    },
    revealPath: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path),
  });
  windowHosts.set(window.id, windowHost);
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => {
    windowHosts.delete(window.id);
    void windowHost.close();
  });
  const developmentUrl = process.env["ELECTRON_RENDERER_URL"];
  if (initialProjectPath !== undefined) {
    try {
      await windowHost.openProject(initialProjectPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const startup = await startupPromise;
      startup?.logger.write({
        level: "error",
        scope: "ProjectStore",
        event: "project.open.failed",
        msg: message,
        data: { projectPath: initialProjectPath },
      });
    }
  }
  if (developmentUrl === undefined) {
    await window.loadFile(join(currentDirectory, "../renderer/index.html"));
  } else {
    await window.loadURL(developmentUrl);
  }
  return window;
}

async function startApplication(): Promise<void> {
  const startup = await startupPromise;
  if (startup === undefined) return;
  if (startup.safeMode) {
    app.commandLine.appendSwitch("disable-gpu");
    startup.logger.write({
      level: "warn",
      scope: "app",
      event: "app.safe-mode",
      msg: "Guyditor started in safe mode after repeated unclean exits.",
    });
  }
  appHost = new AppServiceHost({
    appVersion: app.getVersion(),
    userDirectory: startup.userDirectory,
    autoStartMlworker: startup.settings.mlworker.autoStart && !startup.safeMode,
    profilesRoot: resolve(currentDirectory, "../../../../profiles"),
    credentials: safeStorage.isEncryptionAvailable()
      ? new SafeStorageCredentialStore({
          userDir: startup.userDirectory,
          codec: safeStorage,
        })
      : new EphemeralCredentialStore(),
    settings: {
      auditRetentionDays: startup.settings.audit.retentionDays,
      budgets: startup.settings.budgets,
      maxConcurrentJobs: startup.settings.performance.maxConcurrentJobs,
      rightsRequirementLevel: startup.settings.rights.requirementLevel,
      restyleAdapter: startup.settings.adapters.restyle.kling,
    },
  });
  registerIpc();
  await createWindow(projectPathFromArgv(process.argv));

  app.on("second-instance", (_event, argv) => {
    const projectPath = projectPathFromArgv(argv);
    if (projectPath !== undefined) {
      void createWindow(projectPath);
      return;
    }
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing !== undefined) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void (async () => {
      await appHost?.close();
      rmSync(startup.crashMarker, { force: true });
      writeFileSync(startup.crashCountPath, "0\n", { mode: 0o600 });
      startup.logger.write({
        level: "info",
        scope: "app",
        event: "app.stop",
        msg: "Guyditor stopped cleanly.",
      });
      app.quit();
    })();
  });
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(startApplication);
  app.on("window-all-closed", () => app.quit());
}
