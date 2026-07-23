# Restore Guyditor after machine loss

Use this procedure on a clean replacement machine. It restores accepted project state and the portable user environment without copying credentials or machine-specific capability records.

## Before starting

1. Install the same Guyditor version recorded in the backup manifest, or a newer compatible version. Do not open a newer-format backup with an older application.
2. Attach the backup target. For `local-path`, mount the removable disk or NAS path. For `rclone-remote`, install `rclone` and configure the remote in the replacement machine's own rclone configuration; Guyditor never stores those credentials.
3. Choose an empty destination for the project and a fresh Guyditor user-data directory. A real restore refuses a non-empty project destination.

## Restore the user environment

1. In **Storage & recovery**, import the latest `guyditor-env-*.zip`, or select a project backup that captured `include.environment: true`.
2. Review the environment import report. Every entry is SHA-256 checked before it is written. Existing files are copied to `pre-import-<date>/` first.
3. Review every absolute path flagged from `settings.json`; update paths that only existed on the lost machine.
4. Confirm that global skills, brand skills, presets, templates, platform-profile overrides, settings, and adapter manifests/configuration are present.
5. Use the report's `secretPlaceholders` checklist to re-enter provider credentials in adapter settings. Credentials belong in the OS keychain and are deliberately absent from the bundle and normal backups. Until each required key is entered, the adapter must show **needs credentials**.

Reject an environment bundle with `E_ENV_BUNDLE_INVALID`. Do not bypass a failed entry hash or a manifest whose `secretsExcluded` value is not literal `true`.

## Restore the project

1. Open **Restore project**, select the backup target and project, and choose a non-damaged backup run. A damage-flagged run may be inspected but should not be used unless no verified run exists.
2. Run a full restore into the empty destination. Guyditor verifies the backup manifest and SHA-256 of every content-addressed object before and during materialization.
3. Wait for project validation and revision-chain replay. The final `history/HEAD` and journal result revision must match `projectRevision` in the manifest.
4. If verification or validation fails, stop. `E_RESTORE_INTEGRITY_FAILED` identifies the failing entries, and the incomplete destination is renamed as a quarantine rather than opened.
5. Out-of-tree sources are materialized under `<project>/restored-sources/`. Relink them through `asset.relink`, which checks the restored bytes against the recorded ingest hash. If an asset is in cold storage, use **Restore archived media** first; the archive copy is retained after restore.
6. Open the restored project. Hardware capabilities are detected again on this machine. Proxies, waveforms, thumbnails, analysis data, and render caches were intentionally not backed up and will regenerate as visible background jobs.
7. Confirm that the accepted revision matches the backup manifest. Apply and accept a harmless edit, then render a short HQ preview segment. Compare the reported tool versions when exact same-platform reproducibility matters.

## Non-destructive restore test

Use **Test restore** before an emergency whenever practical. `backup.restoreTest` performs a full materialization, project validation, and revision-chain check below the operating-system temporary directory, never inside the live project. It removes the scratch copy unless **Keep scratch** was explicitly selected.

## Physical-machine AC-012 check

The automated AC-012 suite simulates a clean machine with fresh project and user-data directories. Before closing M4, repeat this runbook on a physically different machine and record in the M4 dogfood report:

- source machine, replacement machine, Guyditor versions, and date;
- backup target kind and selected backup ID;
- full verification and revision-chain result;
- restored skills, presets, profiles, and adapter configuration;
- confirmation that no credential transferred and the adapter initially reported **needs credentials**;
- credential re-entry result;
- accepted edit transaction/revision and HQ preview report;
- any workaround, quarantined run, or damaged entry.

