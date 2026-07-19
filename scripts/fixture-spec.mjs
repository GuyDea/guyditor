export const FIXTURE_GENERATOR_VERSION = "1.1.0";

export const REQUIRED_PROJECT_TEMPLATES = Object.freeze(["basic", "annotated"]);

export const REQUIRED_PROJECT_TEMPLATE_PATHS = Object.freeze([
  "episode.guyditor.yaml",
  "history/HEAD",
  "history/revisions/rev_00001.yaml",
  "history/revisions/rev_00001.lock.json",
  "history/transactions.jsonl",
  "sidecars/annotations.yaml",
  "sidecars/generated-frozen.json",
  "sidecars/transcript-speech.json",
]);

export const REQUIRED_FIXTURE_PATHS = Object.freeze([
  "bars-1080p30-10s.mp4",
  "speech-48k-20s.wav",
  "greenscreen-720p30-6s.mp4",
  "screencast-1080p30-15s.mp4",
  "avsync-video.mp4",
  "avsync-audio.wav",
  "stills/diagram-1080.png",
  "stills/logo-256.png",
  "disc-track-720p30-8s.mp4",
  "generated/frozen-overlay.png",
  "transcripts/short-exact.json",
  "transcripts/drift-2800w-20m.json",
]);

export const REQUIRED_GROUND_TRUTH_KEYS = Object.freeze({
  "bars-1080p30-10s.mp4": Object.freeze(["fps", "frameCount"]),
  "speech-48k-20s.wav": Object.freeze(["silenceMap"]),
  "greenscreen-720p30-6s.mp4": Object.freeze([
    "keyColor",
    "subjectBoundingBoxPath",
  ]),
  "screencast-1080p30-15s.mp4": Object.freeze(["cutFrame"]),
  "avsync-video.mp4": Object.freeze(["offsetMilliseconds", "flashFrame"]),
  "avsync-audio.wav": Object.freeze([
    "offsetMilliseconds",
    "shiftedBeepStart",
  ]),
  "stills/diagram-1080.png": Object.freeze(["height", "width"]),
  "stills/logo-256.png": Object.freeze(["height", "width"]),
  "disc-track-720p30-8s.mp4": Object.freeze(["centerPath", "radius"]),
  "generated/frozen-overlay.png": Object.freeze(["frozen", "height", "width"]),
  "transcripts/short-exact.json": Object.freeze(["duration", "wordCount"]),
  "transcripts/drift-2800w-20m.json": Object.freeze([
    "duration",
    "wordCount",
  ]),
});

export const EXPECTED_FIXTURE_KINDS = Object.freeze({
  "bars-1080p30-10s.mp4": "video",
  "speech-48k-20s.wav": "audio",
  "greenscreen-720p30-6s.mp4": "video",
  "screencast-1080p30-15s.mp4": "video",
  "avsync-video.mp4": "video",
  "avsync-audio.wav": "audio",
  "stills/diagram-1080.png": "image",
  "stills/logo-256.png": "image",
  "disc-track-720p30-8s.mp4": "video",
  "generated/frozen-overlay.png": "image",
  "transcripts/short-exact.json": "sidecar",
  "transcripts/drift-2800w-20m.json": "sidecar",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expectGroundTruth(errors, fixturePath, truth, key, expected) {
  if (truth[key] !== expected) {
    errors.push(
      `${fixturePath}: groundTruth.${key} must be ${JSON.stringify(expected)}`,
    );
  }
}

function expectPath(
  errors,
  fixturePath,
  truth,
  key,
  frameCount,
  coordinateFields,
  positiveFields = [],
) {
  const value = truth[key];
  if (
    !Array.isArray(value) ||
    value.length !== frameCount ||
    value.some(
      (sample, frame) =>
        !isRecord(sample) ||
        sample.frame !== frame ||
        coordinateFields.some(
          (field) =>
            !Number.isFinite(sample[field]) ||
            (positiveFields.includes(field) && sample[field] <= 0),
        ),
    )
  ) {
    errors.push(
      `${fixturePath}: groundTruth.${key} must contain frames 0..${
        frameCount - 1
      } with finite ${coordinateFields.join("/")}${
        positiveFields.length > 0
          ? ` and positive ${positiveFields.join("/")}`
          : ""
      }`,
    );
  }
}

function expectDuration(
  errors,
  fixturePath,
  truth,
  expectedSamples,
) {
  const duration = truth.duration;
  if (
    !isRecord(duration) ||
    duration.rate !== 48_000 ||
    duration.samples !== expectedSamples
  ) {
    errors.push(
      `${fixturePath}: groundTruth.duration must be {rate:48000,samples:${expectedSamples}}`,
    );
  }
}

function validateGroundTruth(errors, fixturePath, truth) {
  switch (fixturePath) {
    case "bars-1080p30-10s.mp4":
      expectGroundTruth(errors, fixturePath, truth, "fps", "30/1");
      expectGroundTruth(errors, fixturePath, truth, "frameCount", 300);
      break;
    case "speech-48k-20s.wav": {
      const expected = [
        { end: "19/5", start: "3/1" },
        { end: "51/5", start: "9/1" },
        { end: "16/1", start: "31/2" },
      ];
      if (JSON.stringify(truth.silenceMap) !== JSON.stringify(expected)) {
        errors.push(
          `${fixturePath}: groundTruth.silenceMap must match the scripted intervals`,
        );
      }
      break;
    }
    case "greenscreen-720p30-6s.mp4":
      expectGroundTruth(errors, fixturePath, truth, "keyColor", "0x00B140");
      expectPath(
        errors,
        fixturePath,
        truth,
        "subjectBoundingBoxPath",
        180,
        ["x", "y", "width", "height"],
        ["width", "height"],
      );
      break;
    case "screencast-1080p30-15s.mp4":
      expectGroundTruth(errors, fixturePath, truth, "cutFrame", 225);
      break;
    case "avsync-video.mp4":
      expectGroundTruth(errors, fixturePath, truth, "offsetMilliseconds", 500);
      expectGroundTruth(errors, fixturePath, truth, "flashFrame", 60);
      break;
    case "avsync-audio.wav":
      expectGroundTruth(errors, fixturePath, truth, "offsetMilliseconds", 500);
      expectGroundTruth(errors, fixturePath, truth, "shiftedBeepStart", "5/2");
      break;
    case "stills/diagram-1080.png":
      expectGroundTruth(errors, fixturePath, truth, "height", 1080);
      expectGroundTruth(errors, fixturePath, truth, "width", 1920);
      break;
    case "stills/logo-256.png":
      expectGroundTruth(errors, fixturePath, truth, "height", 256);
      expectGroundTruth(errors, fixturePath, truth, "width", 256);
      break;
    case "disc-track-720p30-8s.mp4":
      expectPath(errors, fixturePath, truth, "centerPath", 240, ["x", "y"]);
      expectGroundTruth(errors, fixturePath, truth, "radius", 48);
      break;
    case "generated/frozen-overlay.png":
      expectGroundTruth(errors, fixturePath, truth, "frozen", true);
      expectGroundTruth(errors, fixturePath, truth, "height", 360);
      expectGroundTruth(errors, fixturePath, truth, "width", 640);
      break;
    case "transcripts/short-exact.json":
      expectDuration(errors, fixturePath, truth, 576_000);
      expectGroundTruth(errors, fixturePath, truth, "wordCount", 24);
      break;
    case "transcripts/drift-2800w-20m.json":
      expectDuration(errors, fixturePath, truth, 57_600_000);
      expectGroundTruth(errors, fixturePath, truth, "wordCount", 2_800);
      break;
  }
}

export function validateFixtureManifest(manifest) {
  const errors = [];
  if (manifest === null || typeof manifest !== "object") {
    return ["manifest root must be an object"];
  }
  if (
    typeof manifest.generatorVersion !== "string" ||
    manifest.generatorVersion.length === 0
  ) {
    errors.push("generatorVersion must be a non-empty string");
  }
  if (
    typeof manifest.ffmpegVersion !== "string" ||
    manifest.ffmpegVersion.length === 0
  ) {
    errors.push("ffmpegVersion must be a non-empty string");
  }
  if (
    manifest.files === null ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  ) {
    errors.push("files must be an object");
    return errors;
  }

  for (const fixturePath of REQUIRED_FIXTURE_PATHS) {
    const entry = manifest.files[fixturePath];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`missing required fixture entry: ${fixturePath}`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/u.test(entry.sha256 ?? "")) {
      errors.push(`${fixturePath}: sha256 must be 64 lowercase hex characters`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
      errors.push(`${fixturePath}: bytes must be a positive safe integer`);
    }
    if (entry.kind !== EXPECTED_FIXTURE_KINDS[fixturePath]) {
      errors.push(
        `${fixturePath}: kind must be ${EXPECTED_FIXTURE_KINDS[fixturePath]}`,
      );
    }
    if (
      entry.groundTruth === null ||
      typeof entry.groundTruth !== "object" ||
      Array.isArray(entry.groundTruth)
    ) {
      errors.push(`${fixturePath}: groundTruth must be an object`);
      continue;
    }
    for (const key of REQUIRED_GROUND_TRUTH_KEYS[fixturePath]) {
      if (!(key in entry.groundTruth)) {
        errors.push(`${fixturePath}: groundTruth.${key} is required`);
      }
    }
    validateGroundTruth(errors, fixturePath, entry.groundTruth);
  }
  if (!isRecord(manifest.projects)) {
    errors.push("projects must be an object");
    return errors;
  }
  for (const name of REQUIRED_PROJECT_TEMPLATES) {
    const project = manifest.projects[name];
    if (!isRecord(project) || !isRecord(project.files)) {
      errors.push(`missing required project template: ${name}`);
      continue;
    }
    for (const projectPath of REQUIRED_PROJECT_TEMPLATE_PATHS) {
      const entry = project.files[projectPath];
      if (!isRecord(entry)) {
        errors.push(`${name}: missing project file ${projectPath}`);
        continue;
      }
      if (!/^[0-9a-f]{64}$/u.test(entry.sha256 ?? "")) {
        errors.push(`${name}/${projectPath}: sha256 must be 64 lowercase hex characters`);
      }
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
        errors.push(`${name}/${projectPath}: bytes must be a positive safe integer`);
      }
    }
    const truth = project.groundTruth;
    if (
      !isRecord(truth) || truth.revision !== "rev_00001" ||
      truth.schemaValid !== true ||
      typeof truth.sequenceId !== "string" ||
      typeof truth.primaryDeliverableId !== "string" ||
      typeof truth.transcriptAssetId !== "string" ||
      truth.annotationCount !== (name === "annotated" ? 1 : 0)
    ) {
      errors.push(`${name}: project groundTruth is invalid`);
    }
    if (
      name === "annotated" &&
      (!isRecord(truth?.exactFrame) || truth.exactFrame.frames !== 90 ||
        truth.exactFrame.fps !== "30/1")
    ) {
      errors.push("annotated: groundTruth.exactFrame must be frame 90 at 30/1");
    }
  }
  return errors;
}
