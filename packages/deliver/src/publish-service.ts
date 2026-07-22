import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { parse, stringify } from "yaml";

import { makeGuyditorError } from "../../core/src/index.js";
import type { GuyditorProject } from "../../core/src/index.js";
import { loadPlatformProfile } from "./profile.js";
import type { PlatformProfileRoots } from "./profile.js";
import {
  chaptersTextBlock,
  metadataTextBlock,
  validateMetadata,
} from "./publish.js";
import type { ChapterList, PublishMetadata } from "./publish.js";

export type KitFileRole =
  | "video-burned"
  | "video-clean"
  | "thumbnail"
  | "cover"
  | "subtitles-srt"
  | "subtitles-vtt"
  | "chapters"
  | "metadata"
  | "transcript"
  | "export-report";

export interface UploadKitManifest {
  format: "guyditor-kit/v1";
  deliverableId: string;
  profile: string;
  revision: string;
  createdAt: string;
  files: Array<{ role: KitFileRole; path: string; sha256: string; bytes: number }>;
  validation: { passed: true; warnings: string[] };
}

export interface PublishFileResult {
  path: string;
  sha256: string;
  bytes: number;
}

export interface PublishServiceOptions {
  projectRoot: string;
  project: () => GuyditorProject;
  profilesRoot?: string | URL;
  userProfilesRoot?: string | URL;
  validateExport?: (deliverableId: string, revision: string) => Promise<{
    outcome: "pass" | "warnings" | "blocked";
    checks: Array<{ status: "pass" | "warn" | "fail"; message: string }>;
  }>;
}

let temporaryOrdinal = 0;

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

async function atomicWrite(path: string, bytes: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  temporaryOrdinal += 1;
  const temporary = `${path}.tmp-${String(process.pid)}-${String(temporaryOrdinal)}`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function metadataDocument(value: unknown): PublishMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Publish metadata YAML must contain an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record["format"] !== "guyditor-publish/v1" ||
    typeof record["deliverableId"] !== "string" ||
    typeof record["profile"] !== "string" ||
    typeof record["language"] !== "string" ||
    typeof record["title"] !== "string" ||
    typeof record["description"] !== "string" ||
    !Array.isArray(record["tags"]) || !record["tags"].every((entry) => typeof entry === "string") ||
    !Array.isArray(record["hashtags"]) || !record["hashtags"].every((entry) => typeof entry === "string") ||
    (record["status"] !== "draft" && record["status"] !== "approved" && record["status"] !== "stale")
  ) throw new TypeError("Publish metadata YAML does not match guyditor-publish/v1.");
  return structuredClone(value) as PublishMetadata;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new TypeError("Selected thumbnail is not a valid PNG.");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export class PublishService {
  readonly #projectRoot: string;
  readonly #project: () => GuyditorProject;
  readonly #profilesRoot: string | URL | undefined;
  readonly #userProfilesRoot: string | URL | undefined;
  readonly #validateExport: PublishServiceOptions["validateExport"];

  public constructor(options: PublishServiceOptions) {
    this.#projectRoot = resolve(options.projectRoot);
    this.#project = options.project;
    this.#profilesRoot = options.profilesRoot;
    this.#userProfilesRoot = options.userProfilesRoot;
    this.#validateExport = options.validateExport;
  }

  public async writeMetadata(
    metadata: PublishMetadata,
    options: { skipValidation?: boolean } = {},
  ): Promise<PublishFileResult> {
    const deliverable = this.#project().deliverables.find(({ id }) => id === metadata.deliverableId);
    if (deliverable === undefined) throw new TypeError(`Deliverable ${metadata.deliverableId} does not exist.`);
    const profile = await this.#loadProfile(deliverable.profile, deliverable.profileOverrides);
    const errors = validateMetadata(metadata, profile);
    if (errors.length > 0 && options.skipValidation !== true) {
      throw makeGuyditorError(
        "E_METADATA_LIMIT_EXCEEDED",
        `Metadata exceeds ${profile.displayName} limits.`,
        {
          affected: [metadata.deliverableId],
          retry: "none",
          suggestion: errors[0]!.suggestion,
        },
      );
    }
    return this.#writeRelative(
      `publish/${metadata.deliverableId}/metadata.yaml`,
      stringify(metadata, { lineWidth: 0 }),
    );
  }

  public async writeChapters(list: ChapterList): Promise<PublishFileResult[]> {
    const yaml = await this.#writeRelative(
      `publish/${list.deliverableId}/chapters.yaml`,
      stringify(list, { lineWidth: 0 }),
    );
    const text = await this.writeText(
      list.deliverableId,
      "chapters",
      chaptersTextBlock(list.chapters),
    );
    return [yaml, text];
  }

  public writeText(
    deliverableId: string,
    target: "transcript" | "chapters" | "metadata",
    text: string,
  ): Promise<PublishFileResult> {
    return this.#writeRelative(`publish/${deliverableId}/${target}.txt`, text);
  }

  public async writeTextExports(
    deliverableId: string,
    targets: readonly ("transcript" | "chapters" | "metadata")[],
  ): Promise<PublishFileResult[]> {
    const deliverable = this.#project().deliverables.find(({ id }) => id === deliverableId);
    if (deliverable === undefined) throw new TypeError(`Deliverable ${deliverableId} does not exist.`);
    const results: PublishFileResult[] = [];
    for (const target of targets) {
      if (target === "metadata") {
        const metadata = deliverable.publish?.metadata;
        if (metadata === undefined) throw new TypeError(`Deliverable ${deliverableId} has no metadata.`);
        results.push(await this.writeText(deliverableId, target, metadataTextBlock(metadata)));
      } else if (target === "chapters") {
        const chapters = deliverable.publish?.chapters;
        if (chapters === undefined) throw new TypeError(`Deliverable ${deliverableId} has no chapters.`);
        results.push(await this.writeText(deliverableId, target, chaptersTextBlock(chapters.chapters)));
      } else {
        const path = join(this.#projectRoot, `publish/${deliverableId}/transcript.txt`);
        const bytes = await stat(path);
        results.push({
          path: relative(this.#projectRoot, path),
          sha256: await fileSha256(path),
          bytes: bytes.size,
        });
      }
    }
    return results;
  }

  public async buildKit(deliverableId: string): Promise<{
    path: string;
    manifest: UploadKitManifest;
  }> {
    const project = this.#project();
    const deliverable = project.deliverables.find(({ id }) => id === deliverableId);
    if (deliverable === undefined) throw this.#kitFailure(deliverableId, "Deliverable does not exist.");
    if (deliverable.status !== "approved" || deliverable.approvedRevision === undefined) {
      throw this.#kitFailure(deliverableId, "Deliverable must be approved and non-stale.");
    }
    if (this.#validateExport !== undefined) {
      const validation = await this.#validateExport(deliverableId, project.revision);
      if (validation.outcome === "blocked") {
        throw this.#kitFailure(
          deliverableId,
          validation.checks.filter(({ status }) => status === "fail")
            .map(({ message }) => message).join("; "),
        );
      }
    }
    if (deliverable.publish?.metadata?.status !== "approved") {
      throw this.#kitFailure(deliverableId, "Publish metadata must be approved and non-stale.");
    }
    const loaded = await loadPlatformProfile(deliverable.profile, {
      projectRoot: join(this.#projectRoot, "profiles"),
      ...(this.#userProfilesRoot === undefined ? {} : { userRoot: this.#userProfilesRoot }),
      ...(this.#profilesRoot === undefined ? {} : { builtinsRoot: this.#profilesRoot }),
      ...(deliverable.profileOverrides === undefined ? {} : { overrides: deliverable.profileOverrides }),
    });
    if (loaded.profile.chapters !== null && deliverable.publish.chapters?.status !== "approved") {
      throw this.#kitFailure(deliverableId, "Chapters must be approved and non-stale.");
    }
    if (deliverable.kind === "longform" && deliverable.publish.selectedThumbnail === undefined) {
      throw this.#kitFailure(deliverableId, "Select a long-form thumbnail before building the kit.");
    }
    const metadataPath = join(this.#projectRoot, `publish/${deliverableId}/metadata.yaml`);
    let metadata: PublishMetadata;
    try {
      metadata = metadataDocument(parse((await this.#readRequired(
        metadataPath,
        deliverableId,
        "metadata.yaml",
      )).toString("utf8")) as unknown);
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "E_KIT_VALIDATION_FAILED") {
        throw error;
      }
      throw this.#kitFailure(deliverableId, error instanceof Error ? error.message : String(error));
    }
    const metadataErrors = validateMetadata(metadata, loaded.profile);
    if (metadataErrors.length > 0) {
      throw this.#kitFailure(deliverableId, metadataErrors.map(({ suggestion }) => suggestion).join("; "));
    }
    const output = join(this.#projectRoot, "exports", deliverableId);
    const reportPath = join(output, "export-report.json");
    let report: unknown;
    try {
      report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    } catch (error: unknown) {
      throw this.#kitFailure(
        deliverableId,
        `Export report is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof report !== "object" || report === null || Array.isArray(report)) {
      throw this.#kitFailure(deliverableId, "Export report must contain an object.");
    }
    const reportRecord = report as Record<string, unknown>;
    if (reportRecord["deliverableId"] !== deliverableId) {
      throw this.#kitFailure(deliverableId, "Export report belongs to another deliverable.");
    }
    if (reportRecord["revision"] !== project.revision) {
      throw this.#kitFailure(
        deliverableId,
        `Export report revision ${String(reportRecord["revision"])} does not match ${project.revision}.`,
      );
    }
    const outputSet = reportRecord["outputSet"];
    const artifacts = typeof outputSet === "object" && outputSet !== null && !Array.isArray(outputSet)
      ? (outputSet as Record<string, unknown>)["artifacts"]
      : undefined;
    if (!Array.isArray(artifacts)) {
      throw this.#kitFailure(deliverableId, "Export report has no consolidated output-set hashes.");
    }
    const exportHashes = new Map<string, string>();
    for (const artifact of artifacts) {
      if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
        throw this.#kitFailure(deliverableId, "Export report contains an invalid output-set artifact.");
      }
      const entry = artifact as Record<string, unknown>;
      if (typeof entry["path"] !== "string" ||
          typeof entry["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(entry["sha256"])) {
        throw this.#kitFailure(deliverableId, "Export report contains an invalid output-set artifact hash.");
      }
      exportHashes.set(entry["path"], entry["sha256"]);
    }
    if (loaded.profile.chapters !== null) {
      const chapters = deliverable.publish.chapters!;
      const rules = loaded.profile.chapters;
      if (chapters.chapters.length < rules.minCount) {
        throw this.#kitFailure(deliverableId, `Chapters require at least ${String(rules.minCount)} entries.`);
      }
      if (rules.firstMustBeZero && chapters.chapters[0]?.startSeconds !== 0) {
        throw this.#kitFailure(deliverableId, "The first chapter must start at 0:00.");
      }
      if (chapters.chapters.some((chapter, index) => index > 0 &&
          chapter.startSeconds - chapters.chapters[index - 1]!.startSeconds < rules.minChapterSeconds)) {
        throw this.#kitFailure(
          deliverableId,
          `Chapters must be at least ${String(rules.minChapterSeconds)} seconds apart.`,
        );
      }
      const chaptersText = (await this.#readRequired(
        join(this.#projectRoot, `publish/${deliverableId}/chapters.txt`),
        deliverableId,
        "chapters.txt",
      )).toString("utf8");
      if (createHash("sha256").update(chaptersText).digest("hex") !== chapters.textSha256) {
        throw this.#kitFailure(deliverableId, "chapters.txt does not match the approved chapter text hash.");
      }
    }
    if (deliverable.kind === "longform") {
      const selected = deliverable.publish.selectedThumbnail!;
      if (!/^[A-Za-z0-9._-]+$/u.test(selected)) {
        throw this.#kitFailure(deliverableId, "Selected thumbnail name is invalid.");
      }
      const thumbnailPath = join(this.#projectRoot, `publish/${deliverableId}/thumbnails/${selected}.png`);
      const thumbnail = await this.#readRequired(thumbnailPath, deliverableId, "selected thumbnail");
      let dimensions: { width: number; height: number };
      try {
        dimensions = pngDimensions(thumbnail);
      } catch (error: unknown) {
        throw this.#kitFailure(deliverableId, error instanceof Error ? error.message : String(error));
      }
      const expected = loaded.profile.cover.resolution;
      if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
        throw this.#kitFailure(
          deliverableId,
          `Thumbnail must be ${String(expected.width)}×${String(expected.height)}; received ${String(dimensions.width)}×${String(dimensions.height)}.`,
        );
      }
      if (thumbnail.length > loaded.profile.cover.maxBytes) {
        throw this.#kitFailure(
          deliverableId,
          `Thumbnail is ${String(thumbnail.length)} bytes; profile allows ${String(loaded.profile.cover.maxBytes)}.`,
        );
      }
    }

    const destinationRelative = `exports/kits/${deliverableId}/${deliverable.profile}`;
    const destination = join(this.#projectRoot, destinationRelative);
    temporaryOrdinal += 1;
    const temporary = join(
      this.#projectRoot,
      "exports/kits",
      `.tmp-${deliverableId}-${String(process.pid)}-${String(temporaryOrdinal)}`,
    );
    await rm(temporary, { recursive: true, force: true });
    await mkdir(temporary, { recursive: true });
    try {
      const sources: Array<{ role: KitFileRole; source: string; target: string }> = [
        { role: "video-burned", source: join(output, `video.burned.${loaded.profile.video.container}`), target: `video.burned.${loaded.profile.video.container}` },
        { role: "video-clean", source: join(output, `video.clean.${loaded.profile.video.container}`), target: `video.clean.${loaded.profile.video.container}` },
        { role: "subtitles-srt", source: join(output, "subtitles.srt"), target: "subtitles.srt" },
        { role: "subtitles-vtt", source: join(output, "subtitles.vtt"), target: "subtitles.vtt" },
        { role: "metadata", source: metadataPath, target: "metadata.yaml" },
        { role: "transcript", source: join(this.#projectRoot, `publish/${deliverableId}/transcript.txt`), target: "transcript.txt" },
        { role: "export-report", source: reportPath, target: "export-report.json" },
      ];
      if (deliverable.kind === "short") {
        const covers = (await readdir(join(output, "covers")))
          .filter((name) => /^cover-[0-9]{2}\.(?:jpg|png)$/u.test(name))
          .sort();
        if (covers.length === 0) throw this.#kitFailure(deliverableId, "At least one cover candidate is required.");
        sources.push(...covers.map((name) => ({
          role: "cover" as const,
          source: join(output, "covers", name),
          target: `covers/${name}`,
        })));
      } else {
        const selected = deliverable.publish.selectedThumbnail!;
        sources.push({
          role: "thumbnail",
          source: join(this.#projectRoot, `publish/${deliverableId}/thumbnails/${selected}.png`),
          target: "thumbnail.png",
        });
        sources.push({
          role: "chapters",
          source: join(this.#projectRoot, `publish/${deliverableId}/chapters.txt`),
          target: "chapters.txt",
        });
      }
      for (const source of sources.filter(({ role }) =>
        role === "video-burned" || role === "video-clean" ||
        role === "subtitles-srt" || role === "subtitles-vtt" || role === "cover")) {
        const expected = exportHashes.get(source.target);
        if (expected === undefined) {
          throw this.#kitFailure(deliverableId, `${source.target} has no SHA-256 in the export report.`);
        }
        if (await fileSha256(source.source) !== expected) {
          throw this.#kitFailure(deliverableId, `${source.target} does not match the export report SHA-256.`);
        }
      }
      const files: UploadKitManifest["files"] = [];
      for (const source of sources) {
        const target = join(temporary, source.target);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source.source, target);
        const details = await stat(target);
        files.push({
          role: source.role,
          path: source.target,
          sha256: await fileSha256(target),
          bytes: details.size,
        });
      }
      const manifest: UploadKitManifest = {
        format: "guyditor-kit/v1",
        deliverableId,
        profile: deliverable.profile,
        revision: deliverable.approvedRevision,
        createdAt: new Date().toISOString(),
        files,
        validation: { passed: true, warnings: [] },
      };
      await writeFile(join(temporary, "kit-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await mkdir(dirname(destination), { recursive: true });
      const backup = `${destination}.previous-${String(process.pid)}-${String(temporaryOrdinal)}`;
      await rm(backup, { recursive: true, force: true });
      let hadDestination = false;
      try {
        await rename(destination, backup);
        hadDestination = true;
      } catch (error: unknown) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      try {
        await rename(temporary, destination);
      } catch (error: unknown) {
        if (hadDestination) await rename(backup, destination);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
      return { path: destinationRelative, manifest };
    } catch (error: unknown) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "E_KIT_VALIDATION_FAILED") {
        throw error;
      }
      throw this.#kitFailure(
        deliverableId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #loadProfile(pin: string, overrides?: Record<string, unknown>) {
    const roots: PlatformProfileRoots & { overrides?: Record<string, unknown> } = {
      projectRoot: join(this.#projectRoot, "profiles"),
      ...(this.#userProfilesRoot === undefined ? {} : { userRoot: this.#userProfilesRoot }),
      ...(this.#profilesRoot === undefined ? {} : { builtinsRoot: this.#profilesRoot }),
      ...(overrides === undefined ? {} : { overrides }),
    };
    return (await loadPlatformProfile(pin, roots)).profile;
  }

  async #writeRelative(path: string, bytes: string | Buffer): Promise<PublishFileResult> {
    const absolute = join(this.#projectRoot, path);
    await atomicWrite(absolute, bytes);
    const details = await stat(absolute);
    return { path, sha256: await fileSha256(absolute), bytes: details.size };
  }

  async #readRequired(path: string, deliverableId: string, label: string): Promise<Buffer> {
    try {
      return await readFile(path);
    } catch (error: unknown) {
      throw this.#kitFailure(
        deliverableId,
        `${label} is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #kitFailure(deliverableId: string, suggestion: string) {
    return makeGuyditorError(
      "E_KIT_VALIDATION_FAILED",
      `Upload kit validation failed for ${deliverableId}: ${suggestion}`,
      { affected: [deliverableId], retry: "safe", suggestion },
    );
  }
}
