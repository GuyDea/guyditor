import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FIXTURE_GENERATOR_VERSION,
  REQUIRED_FIXTURE_PATHS,
  validateFixtureManifest,
} from "./fixture-spec.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE_ROOT = path.join(SCRIPT_ROOT, ".fixtures");
const MAX_FIXTURE_BYTES = 25 * 1024 * 1024;
const SAMPLE_RATE = 48_000;
const VIDEO_RATE = 30;
const FIXED_CREATED_AT = "2000-01-01T00:00:00.000Z";

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function isExecutable(candidate) {
  try {
    await access(
      candidate,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function pathExtensions() {
  return process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
}

async function findOnPath(command) {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    const absolute = path.resolve(command);
    return (await isExecutable(absolute)) ? absolute : undefined;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const extension of pathExtensions()) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function binaryVersion(binaryPath) {
  const result = spawnSync(binaryPath, ["-version"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  return `${result.stdout}${result.stderr}`
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

async function resolveBinary(name, environmentVariable) {
  const fileName = executableName(name);
  const candidates = [];
  const override = process.env[environmentVariable];
  if (typeof override === "string" && override.trim().length > 0) {
    candidates.push(override.trim());
  }
  candidates.push(
    path.join(
      SCRIPT_ROOT,
      "packages",
      "media",
      "vendor",
      `${process.platform}-${process.arch}`,
      fileName,
    ),
    path.join(
      SCRIPT_ROOT,
      "packages",
      "media",
      "vendor",
      process.platform,
      fileName,
    ),
    name,
  );
  for (const candidate of candidates) {
    const resolvedPath = await findOnPath(candidate);
    if (resolvedPath === undefined) continue;
    const version = binaryVersion(resolvedPath);
    if (version !== undefined) return { path: resolvedPath, version };
  }
  const error = new Error(`No working ${name} binary was found.`);
  error.code = "E_FFMPEG_MISSING";
  throw error;
}

async function buildMediaRuntime() {
  const buildRoot = await mkdtemp(
    path.join(tmpdir(), "guyditor-media-runtime-"),
  );
  const compilerPath = path.join(
    SCRIPT_ROOT,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  const result = spawnSync(
    process.execPath,
    [
      compilerPath,
      "-p",
      path.join(SCRIPT_ROOT, "packages", "media", "tsconfig.json"),
      "--noEmit",
      "false",
      "--outDir",
      buildRoot,
      "--rootDir",
      path.join(SCRIPT_ROOT, "packages"),
    ],
    { encoding: "utf8", shell: false, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    await rm(buildRoot, { force: true, recursive: true });
    throw new Error(
      `Could not build @guyditor/media for fixture generation: ${
        result.error?.message ?? `${result.stdout}${result.stderr}`.trim()
      }`,
    );
  }
  const media = await import(
    pathToFileURL(path.join(buildRoot, "media", "src", "index.js")).href
  );
  return {
    cleanup: () => rm(buildRoot, { force: true, recursive: true }),
    runFfmpeg: media.runFfmpeg,
    runFfprobe: media.runFfprobe,
  };
}

function ffmpegArgs(args) {
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args];
}

function x264Output(outputPath, crf = "18", preset = "ultrafast") {
  return [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    crf,
    "-pix_fmt",
    "yuv420p",
    "-threads",
    "2",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-map_metadata",
    "-1",
    "-metadata",
    `creation_time=${FIXED_CREATED_AT}`,
    "-movflags",
    "+faststart",
    outputPath,
  ];
}

function rounded(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function greenSubjectPath() {
  return Array.from({ length: 6 * VIDEO_RATE }, (_, frame) => {
    const time = frame / VIDEO_RATE;
    const overlayX = 560 + 300 * Math.sin((2 * Math.PI * time) / 6);
    const overlayY = 250 + 80 * Math.sin((4 * Math.PI * time) / 6);
    return {
      frame,
      height: 210,
      width: 120,
      x: rounded(overlayX + 20),
      y: rounded(overlayY + 5),
    };
  });
}

function discCenterPath() {
  return Array.from({ length: 8 * VIDEO_RATE }, (_, frame) => {
    const time = frame / VIDEO_RATE;
    return {
      frame,
      x: rounded(640 + 420 * Math.sin((2 * Math.PI * time) / 8)),
      y: rounded(360 + 220 * Math.sin((4 * Math.PI * time) / 8)),
    };
  });
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function makeTranscriptFixture({
  assetId,
  durationSamples,
  seed,
  wordCount,
}) {
  const vocabulary = [
    "alpha",
    "camera",
    "dialogue",
    "edit",
    "frame",
    "guide",
    "motion",
    "project",
    "scene",
    "signal",
    "timing",
    "video",
  ];
  const random = mulberry32(seed);
  const words = {};
  const wordIds = [];
  for (let index = 0; index < wordCount; index += 1) {
    const wordId = `w${String(index + 1).padStart(6, "0")}`;
    const slotStart = Math.floor((index * durationSamples) / wordCount);
    const slotEnd = Math.floor(((index + 1) * durationSamples) / wordCount);
    const end = slotStart + Math.floor(((slotEnd - slotStart) * 3) / 4);
    const text = vocabulary[Math.floor(random() * vocabulary.length)];
    wordIds.push(wordId);
    words[wordId] = {
      alignment: "manual",
      confidence: 1,
      end: { rate: SAMPLE_RATE, samples: end },
      origin: "correction",
      punctAfter: (index + 1) % 12 === 0 ? "." : "",
      punctBefore: "",
      start: { rate: SAMPLE_RATE, samples: slotStart },
      state: "active",
      text,
    };
  }
  return {
    assetId,
    audio: { channels: 1, rate: SAMPLE_RATE, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      alignment: {
        model: "deterministic-prng",
        name: "guyditor-fixture-generator",
        version: FIXTURE_GENERATOR_VERSION,
      },
      createdAt: FIXED_CREATED_AT,
      engine: {
        model: "synthetic-word-list",
        name: "guyditor-fixture-generator",
        version: FIXTURE_GENERATOR_VERSION,
      },
      jobId: "job_fixturezzz",
    },
    schema: "guyditor.transcript/v1",
    segments: [
      {
        end: { rate: SAMPLE_RATE, samples: durationSamples },
        id: "seg_fixturezzz",
        language: null,
        speaker: "spk_fixturezzz",
        start: { rate: SAMPLE_RATE, samples: 0 },
        words: wordIds,
      },
    ],
    speakers: [{ id: "spk_fixturezzz", label: "Synthetic" }],
    words,
  };
}

export async function isFixtureManifestFresh(fixtureRoot = DEFAULT_FIXTURE_ROOT) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(fixtureRoot, "manifest.json"), "utf8"),
    );
  } catch {
    return false;
  }
  if (manifest.generatorVersion !== FIXTURE_GENERATOR_VERSION) return false;
  if (validateFixtureManifest(manifest).length > 0) return false;
  for (const fixturePath of REQUIRED_FIXTURE_PATHS) {
    try {
      const fixtureStat = await stat(path.join(fixtureRoot, fixturePath));
      if (!fixtureStat.isFile() || fixtureStat.size !== manifest.files[fixturePath].bytes) {
        return false;
      }
      if (
        (await sha256(path.join(fixtureRoot, fixturePath))) !==
        manifest.files[fixturePath].sha256
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function writeJson(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function createBars(runFfmpeg, fixtureRoot) {
  const outputPath = path.join(fixtureRoot, "bars-1080p30-10s.mp4");
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "smptehdbars=size=1920x1080:rate=30:duration=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=10",
      "-vf",
      "drawtext=font=monospace:text='%{n}':fontcolor=white:fontsize=72:box=1:boxcolor=black@0.65:x=40:y=40",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-shortest",
      ...x264Output(outputPath),
    ]),
  );
}

async function createSpeech(runFfmpeg, fixtureRoot) {
  const outputPath = path.join(fixtureRoot, "speech-48k-20s.wav");
  const silenceExpression = [
    "between(t\\,3\\,3.8)",
    "between(t\\,9\\,10.2)",
    "between(t\\,15.5\\,16)",
  ].join("+");
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:sample_rate=48000:duration=20:amplitude=0.32:seed=119657300",
      "-af",
      `highpass=f=200,lowpass=f=3000,tremolo=f=4:d=0.7,volume=volume=0:enable='${silenceExpression}'`,
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-map_metadata",
      "-1",
      outputPath,
    ]),
  );
}

async function createGreenscreen(runFfmpeg, fixtureRoot) {
  const outputPath = path.join(fixtureRoot, "greenscreen-720p30-6s.mp4");
  const ellipse = "lte(pow((X-80)/60,2)+pow((Y-70)/65,2),1)";
  const filter = [
    `[1:v]format=rgba,geq=r='255':g='255':b='255':a='if(${ellipse},255,0)',`,
    "drawbox=x=45:y=120:w=70:h=95:color=0x202020@1:t=fill:replace=1[subject];",
    "[0:v][subject]overlay=x='560+300*sin(2*PI*t/6)':y='250+80*sin(4*PI*t/6)':eval=frame:shortest=1,",
    "noise=alls=6:all_seed=4242,format=yuv420p[out]",
  ].join("");
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x00B140:size=1280x720:rate=30:duration=6",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=size=160x220:rate=30:duration=6",
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      ...x264Output(outputPath, "24", "veryfast"),
    ]),
  );
}

async function createScreencast(runFfmpeg, fixtureRoot) {
  const outputPath = path.join(fixtureRoot, "screencast-1080p30-15s.mp4");
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=30:duration=7.5",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=30:duration=7.5",
      "-filter_complex",
      "[0:v]setpts=PTS-STARTPTS[first];[1:v]hue=h=90,setpts=PTS-STARTPTS[second];[first][second]concat=n=2:v=1:a=0,format=yuv420p[out]",
      "-map",
      "[out]",
      ...x264Output(outputPath, "28", "veryfast"),
    ]),
  );
}

function beepExpression(start) {
  const end = start + 0.1;
  return `if(between(t,${start},${end}),0.8*sin(2*PI*1000*(t-${start})),0)`;
}

async function createAvsync(runFfmpeg, fixtureRoot) {
  const videoPath = path.join(fixtureRoot, "avsync-video.mp4");
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "color=c=black:size=1280x720:rate=30:duration=5",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=exprs='${beepExpression(2)}':sample_rate=48000:duration=5`,
      "-vf",
      "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,60)'",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-shortest",
      ...x264Output(videoPath),
    ]),
  );

  const audioPath = path.join(fixtureRoot, "avsync-audio.wav");
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      `aevalsrc=exprs='${beepExpression(2.5)}':sample_rate=48000:duration=5`,
      "-c:a",
      "pcm_s16le",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-map_metadata",
      "-1",
      audioPath,
    ]),
  );
}

async function createStills(runFfmpeg, fixtureRoot) {
  const stillsRoot = path.join(fixtureRoot, "stills");
  await mkdir(stillsRoot, { recursive: true });
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "color=c=0xF3F0E8:size=1920x1080:rate=1:duration=1",
      "-vf",
      "drawgrid=w=240:h=180:t=2:c=0xC8C2B8,drawbox=x=240:y=240:w=480:h=260:c=0x183153:t=fill,drawbox=x=1200:y=580:w=480:h=260:c=0xD06B42:t=fill,drawtext=font=monospace:text='GUYDITOR DIAGRAM':fontcolor=0x183153:fontsize=64:x=(w-text_w)/2:y=80,drawtext=font=monospace:text='SOURCE':fontcolor=white:fontsize=52:x=360:y=340,drawtext=font=monospace:text='OUTPUT':fontcolor=white:fontsize=52:x=1320:y=680",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-map_metadata",
      "-1",
      path.join(stillsRoot, "diagram-1080.png"),
    ]),
  );
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x183153:size=256x256:rate=1:duration=1",
      "-vf",
      "drawbox=x=24:y=24:w=208:h=208:c=0xD06B42:t=8,drawtext=font=monospace:text='G':fontcolor=white:fontsize=150:x=(w-text_w)/2:y=(h-text_h)/2-12",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-map_metadata",
      "-1",
      path.join(stillsRoot, "logo-256.png"),
    ]),
  );
}

async function createDiscTrack(runFfmpeg, fixtureRoot) {
  const outputPath = path.join(fixtureRoot, "disc-track-720p30-8s.mp4");
  const filter = [
    "[1:v]format=rgba,geq=r='255':g='255':b='255':",
    "a='if(lte(pow(X-48,2)+pow(Y-48,2),2304),255,0)'[disc];",
    "[0:v][disc]overlay=x='592+420*sin(2*PI*t/8)':",
    "y='312+220*sin(4*PI*t/8)':eval=frame:shortest=1,format=yuv420p[out]",
  ].join("");
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "color=c=black:size=1280x720:rate=30:duration=8",
      "-f",
      "lavfi",
      "-i",
      "nullsrc=size=96x96:rate=30:duration=8",
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      ...x264Output(outputPath),
    ]),
  );
}

async function createTranscripts(fixtureRoot) {
  await writeJson(
    path.join(fixtureRoot, "transcripts", "short-exact.json"),
    makeTranscriptFixture({
      assetId: "ast_shortexact",
      durationSamples: 12 * SAMPLE_RATE,
      seed: 0x53_48_4f_52,
      wordCount: 24,
    }),
  );
  await writeJson(
    path.join(fixtureRoot, "transcripts", "drift-2800w-20m.json"),
    makeTranscriptFixture({
      assetId: "ast_driftzzzzz",
      durationSamples: 20 * 60 * SAMPLE_RATE,
      seed: 0x47_55_59,
      wordCount: 2_800,
    }),
  );
}

function parseRational(value) {
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? "");
  if (match === null || match[2] === "0") return undefined;
  return { denominator: BigInt(match[2]), numerator: BigInt(match[1]) };
}

function canonicalRate(value) {
  const fraction = parseRational(value);
  if (fraction === undefined || fraction.numerator === 0n) return undefined;
  let left = fraction.numerator;
  let right = fraction.denominator;
  while (right !== 0n) [left, right] = [right, left % right];
  return `${fraction.numerator / left}/${fraction.denominator / left}`;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

function audioSampleCount(stream) {
  const durationTimestamp = /^\d+$/u.test(stream.duration_ts ?? "")
    ? BigInt(stream.duration_ts)
    : undefined;
  const timeBase = parseRational(stream.time_base);
  const sampleRate = /^\d+$/u.test(stream.sample_rate ?? "")
    ? BigInt(stream.sample_rate)
    : undefined;
  if (
    durationTimestamp === undefined ||
    timeBase === undefined ||
    sampleRate === undefined
  ) {
    return undefined;
  }
  const numerator = durationTimestamp * timeBase.numerator * sampleRate;
  return numerator % timeBase.denominator === 0n
    ? Number(numerator / timeBase.denominator)
    : undefined;
}

async function validateMedia(runFfprobe, fixtureRoot, relativePath, expected) {
  const { stdout } = await runFfprobe([
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path.join(fixtureRoot, relativePath),
  ]);
  const parsed = JSON.parse(stdout);
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (expected.width !== undefined) {
    assertEqual(video?.width, expected.width, `${relativePath} width`);
    assertEqual(video?.height, expected.height, `${relativePath} height`);
  }
  if (expected.fps !== undefined) {
    const rate =
      canonicalRate(video?.avg_frame_rate) ?? canonicalRate(video?.r_frame_rate);
    assertEqual(rate, expected.fps, `${relativePath} fps`);
  }
  if (expected.frames !== undefined) {
    assertEqual(Number(video?.nb_frames), expected.frames, `${relativePath} frames`);
  }
  if (expected.sampleRate !== undefined) {
    assertEqual(
      Number(audio?.sample_rate),
      expected.sampleRate,
      `${relativePath} sample rate`,
    );
  }
  if (expected.samples !== undefined) {
    assertEqual(
      audioSampleCount(audio ?? {}),
      expected.samples,
      `${relativePath} samples`,
    );
  }
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function groundTruthByPath() {
  const syncTruth = {
    beepDuration: "1/10",
    flashFrame: 60,
    fps: "30/1",
    offsetMilliseconds: 500,
    referenceBeepStart: "2/1",
    shiftedBeepStart: "5/2",
  };
  return {
    "bars-1080p30-10s.mp4": { fps: "30/1", frameCount: 300 },
    "speech-48k-20s.wav": {
      silenceMap: [
        { end: "19/5", start: "3/1" },
        { end: "51/5", start: "9/1" },
        { end: "16/1", start: "31/2" },
      ],
    },
    "greenscreen-720p30-6s.mp4": {
      keyColor: "0x00B140",
      subjectBoundingBoxPath: greenSubjectPath(),
      subjectMotion: {
        x: "560+300*sin(2*PI*t/6)",
        y: "250+80*sin(4*PI*t/6)",
      },
    },
    "screencast-1080p30-15s.mp4": { cutFrame: 225 },
    "avsync-video.mp4": syncTruth,
    "avsync-audio.wav": syncTruth,
    "stills/diagram-1080.png": { height: 1080, width: 1920 },
    "stills/logo-256.png": { height: 256, width: 256 },
    "disc-track-720p30-8s.mp4": {
      centerPath: discCenterPath(),
      motion: {
        x: "640+420*sin(2*PI*t/8)",
        y: "360+220*sin(4*PI*t/8)",
      },
      radius: 48,
    },
    "transcripts/short-exact.json": {
      duration: { rate: SAMPLE_RATE, samples: 12 * SAMPLE_RATE },
      seed: 0x53_48_4f_52,
      wordCount: 24,
    },
    "transcripts/drift-2800w-20m.json": {
      duration: { rate: SAMPLE_RATE, samples: 20 * 60 * SAMPLE_RATE },
      seed: 0x47_55_59,
      wordCount: 2_800,
    },
  };
}

function kindOf(relativePath) {
  if (relativePath.endsWith(".mp4")) return "video";
  if (relativePath.endsWith(".wav")) return "audio";
  if (relativePath.endsWith(".png")) return "image";
  return "sidecar";
}

async function buildManifest(ffmpeg, fixtureRoot) {
  const truth = groundTruthByPath();
  const files = {};
  let totalBytes = 0;
  for (const relativePath of REQUIRED_FIXTURE_PATHS) {
    const absolutePath = path.join(fixtureRoot, relativePath);
    const fileStat = await stat(absolutePath);
    totalBytes += fileStat.size;
    files[relativePath] = {
      bytes: fileStat.size,
      groundTruth: truth[relativePath],
      kind: kindOf(relativePath),
      sha256: await sha256(absolutePath),
    };
  }
  if (totalBytes >= MAX_FIXTURE_BYTES) {
    throw new Error(
      `Fixture outputs total ${totalBytes} bytes; limit is ${MAX_FIXTURE_BYTES - 1}.`,
    );
  }
  return {
    ffmpegVersion: ffmpeg.version,
    files,
    generatorVersion: FIXTURE_GENERATOR_VERSION,
  };
}

async function validateOutputs(runFfprobe, fixtureRoot) {
  const expectations = {
    "bars-1080p30-10s.mp4": {
      fps: "30/1",
      frames: 300,
      height: 1080,
      sampleRate: 48_000,
      width: 1920,
    },
    "speech-48k-20s.wav": { sampleRate: 48_000, samples: 960_000 },
    "greenscreen-720p30-6s.mp4": {
      fps: "30/1",
      frames: 180,
      height: 720,
      width: 1280,
    },
    "screencast-1080p30-15s.mp4": {
      fps: "30/1",
      frames: 450,
      height: 1080,
      width: 1920,
    },
    "avsync-video.mp4": {
      fps: "30/1",
      frames: 150,
      height: 720,
      sampleRate: 48_000,
      width: 1280,
    },
    "avsync-audio.wav": { sampleRate: 48_000, samples: 240_000 },
    "stills/diagram-1080.png": { height: 1080, width: 1920 },
    "stills/logo-256.png": { height: 256, width: 256 },
    "disc-track-720p30-8s.mp4": {
      fps: "30/1",
      frames: 240,
      height: 720,
      width: 1280,
    },
  };
  for (const [relativePath, expected] of Object.entries(expectations)) {
    await validateMedia(runFfprobe, fixtureRoot, relativePath, expected);
  }

  for (const relativePath of [
    "transcripts/short-exact.json",
    "transcripts/drift-2800w-20m.json",
  ]) {
    const transcript = JSON.parse(
      await readFile(path.join(fixtureRoot, relativePath), "utf8"),
    );
    const expectedWords =
      relativePath === "transcripts/short-exact.json" ? 24 : 2_800;
    assertEqual(
      Object.keys(transcript.words ?? {}).length,
      expectedWords,
      `${relativePath} word count`,
    );
  }
}

export async function generateFixtures({
  fixtureRoot = DEFAULT_FIXTURE_ROOT,
  force = false,
  log = console.log,
} = {}) {
  if (!force && (await isFixtureManifestFresh(fixtureRoot))) {
    log(`fixtures: current manifest found at ${path.relative(SCRIPT_ROOT, fixtureRoot)}; skipping regeneration`);
    return { regenerated: false };
  }

  const startedAt = performance.now();
  const [ffmpeg, ffprobe] = await Promise.all([
    resolveBinary("ffmpeg", "GUYDITOR_FFMPEG"),
    resolveBinary("ffprobe", "GUYDITOR_FFPROBE"),
  ]);
  const previousFfmpegOverride = process.env.GUYDITOR_FFMPEG;
  const previousFfprobeOverride = process.env.GUYDITOR_FFPROBE;
  process.env.GUYDITOR_FFMPEG = ffmpeg.path;
  process.env.GUYDITOR_FFPROBE = ffprobe.path;
  let mediaRuntime;
  try {
    mediaRuntime = await buildMediaRuntime();
    const { runFfmpeg, runFfprobe } = mediaRuntime;
    await rm(fixtureRoot, { force: true, recursive: true });
    await mkdir(fixtureRoot, { recursive: true });

    const steps = [
      ["bars", () => createBars(runFfmpeg, fixtureRoot)],
      ["speech-like audio", () => createSpeech(runFfmpeg, fixtureRoot)],
      ["greenscreen", () => createGreenscreen(runFfmpeg, fixtureRoot)],
      ["screencast", () => createScreencast(runFfmpeg, fixtureRoot)],
      ["A/V sync pair", () => createAvsync(runFfmpeg, fixtureRoot)],
      ["stills", () => createStills(runFfmpeg, fixtureRoot)],
      ["disc tracking", () => createDiscTrack(runFfmpeg, fixtureRoot)],
      ["transcripts", () => createTranscripts(fixtureRoot)],
    ];
    for (const [label, create] of steps) {
      log(`fixtures: generating ${label}`);
      await create();
    }

    log("fixtures: validating media with ffprobe");
    await validateOutputs(runFfprobe, fixtureRoot);
    const manifest = await buildManifest(ffmpeg, fixtureRoot);
    await writeJson(path.join(fixtureRoot, "manifest.json"), manifest);
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    if (elapsedSeconds >= 60) {
      throw new Error(
        `Fixture generation took ${elapsedSeconds.toFixed(2)} s; limit is under 60 s.`,
      );
    }
    const totalBytes = Object.values(manifest.files).reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    log(
      `fixtures: wrote ${Object.keys(manifest.files).length} files (${totalBytes} bytes) in ${elapsedSeconds.toFixed(2)} s`,
    );
    log(
      "fixtures: projects/ templates deferred until the Part 3 project model is ready",
    );
    return { manifest, regenerated: true };
  } finally {
    await mediaRuntime?.cleanup();
    if (previousFfmpegOverride === undefined) {
      delete process.env.GUYDITOR_FFMPEG;
    } else {
      process.env.GUYDITOR_FFMPEG = previousFfmpegOverride;
    }
    if (previousFfprobeOverride === undefined) {
      delete process.env.GUYDITOR_FFPROBE;
    } else {
      process.env.GUYDITOR_FFPROBE = previousFfprobeOverride;
    }
  }
}

export function parseFixtureArguments(args) {
  const normalized = args.filter((argument) => argument !== "--");
  const unknown = normalized.filter((argument) => argument !== "--force");
  if (unknown.length > 0) {
    throw new Error(`Unknown fixture option(s): ${unknown.join(", ")}`);
  }
  return { force: normalized.includes("--force") };
}

export async function main(args = process.argv.slice(2)) {
  await generateFixtures(parseFixtureArguments(args));
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(`fixtures: ${error.message}`);
    process.exitCode = 1;
  });
}
