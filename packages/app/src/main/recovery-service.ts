import type {
  JobQueue,
  ProjectStore,
} from "../../../core/src/index.js";
import {
  ArchiveService,
  BackupService,
  StorageAccountant,
} from "../../../media/src/index.js";
import type {
  ArchivePlan,
  BackupScheduler,
  BackupTarget,
  CleanupPlan,
} from "../../../media/src/index.js";

import type { IpcService } from "./rpc.js";

export interface RecoveryServices {
  archive: ArchiveService;
  backup: BackupService;
  backupScheduler?: BackupScheduler;
  storage: StorageAccountant;
}

export async function createRecoveryServices(
  store: ProjectStore,
  jobs: JobQueue,
  storage: StorageAccountant,
  appVersion: string,
  userDirectory: string,
  secretValues: () => Promise<readonly string[]>,
): Promise<RecoveryServices> {
  const backup = new BackupService({
    appVersion,
    userDirectory,
    secretValues,
    toolVersions: { schema: store.currentProject.format },
  });
  backup.registerJobExecutors(jobs);
  let targets: BackupTarget[] = [];
  let backupScheduler: BackupScheduler | undefined;
  try {
    targets = (await backup.readConfig(store.root)).targets;
    backupScheduler = await backup.createScheduler(store.root, jobs);
  } catch {
    // Projects created before M4 can open without backup configuration.
  }
  const archive = new ArchiveService({
    targets,
    userDirectory,
    backupTrigger: async () => {
      await backup.schedule(store.root, jobs, "scheduled");
    },
  });
  return {
    archive,
    backup,
    ...(backupScheduler === undefined ? {} : { backupScheduler }),
    storage,
  };
}

export function recoveryService(
  project: RecoveryServices & { store: ProjectStore },
): IpcService {
  return {
    scan: () => project.storage.scan(project.store.root),
    planCleanup: ({ categories }: { categories: Parameters<StorageAccountant["planCleanup"]>[1] }) =>
      project.storage.planCleanup(project.store.root, categories),
    executeCleanup: ({ plan }: { plan: CleanupPlan }) =>
      project.storage.executeCleanup(project.store.root, plan),
    run: ({ targetName, reason }: {
      targetName: string;
      reason: "scheduled" | "manual" | "pre-migration" | "quit";
    }) => project.backup.run(project.store.root, targetName, reason),
    verify: ({ target, backupId, mode }: {
      target: BackupTarget;
      backupId: string;
      mode: "sample" | "full";
    }) => project.backup.verify(target, backupId, mode),
    restoreTest: ({ target, backupId, keepScratch }: {
      target: BackupTarget;
      backupId: string;
      keepScratch?: boolean;
    }) => project.backup.restoreTest(target, backupId, {
      knownProjectDirectory: project.store.root,
      ...(keepScratch === undefined ? {} : { keepScratch }),
    }),
    archiveStates: () => project.store.readAssetAvailability(),
    planArchive: ({ targetName, assetIds }: {
      targetName: string;
      assetIds: string[] | "auto";
    }) => project.archive.planOffline(project.store.root, targetName, assetIds),
    offline: ({ plan }: { plan: ArchivePlan }) => project.archive.offline(project.store.root, plan),
    archiveRestore: ({ assetIds, destinations }: {
      assetIds: string[];
      destinations?: Record<string, string>;
    }) => project.archive.restore(project.store.root, assetIds, {
      ...(destinations === undefined ? {} : { destinations }),
    }),
  };
}
