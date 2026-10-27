import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdtemp,
  mkdir,
  copyFile,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  FIXTURE_GENERATOR_VERSION,
  REQUIRED_PROJECT_TEMPLATES,
  REQUIRED_FIXTURE_PATHS,
  validateFixtureManifest,
} from "./fixture-spec.mjs";
import { ensureCaptionFont } from "./setup-caption-font.mjs";

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
  const transcriptResult = spawnSync(
    process.execPath,
    [
      compilerPath,
      "-p",
      path.join(SCRIPT_ROOT, "packages", "transcript", "tsconfig.json"),
      "--noEmit",
      "false",
      "--outDir",
      buildRoot,
      "--rootDir",
      path.join(SCRIPT_ROOT, "packages"),
    ],
    { encoding: "utf8", shell: false, windowsHide: true },
  );
  if (transcriptResult.error || transcriptResult.status !== 0) {
    await rm(buildRoot, { force: true, recursive: true });
    throw new Error(
      `Could not build @guyditor/transcript for fixture generation: ${
        transcriptResult.error?.message ?? `${transcriptResult.stdout}${transcriptResult.stderr}`.trim()
      }`,
    );
  }
  await symlink(
    path.join(SCRIPT_ROOT, "node_modules"),
    path.join(buildRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const [media, core, transcript] = await Promise.all([
    import(pathToFileURL(path.join(buildRoot, "media", "src", "index.js")).href),
    import(pathToFileURL(path.join(buildRoot, "core", "src", "index.js")).href),
    import(pathToFileURL(path.join(buildRoot, "transcript", "src", "index.js")).href),
  ]);
  return {
    cleanup: () => rm(buildRoot, { force: true, recursive: true }),
    core,
    transcript,
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
  for (const projectName of REQUIRED_PROJECT_TEMPLATES) {
    const entries = manifest.projects[projectName].files;
    for (const [projectPath, entry] of Object.entries(entries)) {
      try {
        const absolutePath = path.join(fixtureRoot, "projects", projectName, projectPath);
        const projectStat = await stat(absolutePath);
        if (!projectStat.isFile() || projectStat.size !== entry.bytes) return false;
        if ((await sha256(absolutePath)) !== entry.sha256) return false;
      } catch {
        return false;
      }
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

async function createFrozenOverlay(runFfmpeg, fixtureRoot) {
  const outputPath = path.join(fixtureRoot, "generated", "frozen-overlay.png");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await runFfmpeg(
    ffmpegArgs([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x14202B:size=640x360:rate=1:duration=1",
      "-vf",
      "drawbox=x=48:y=48:w=544:h=264:c=0xF2B84B:t=10,drawtext=font=monospace:text='FROZEN GENERATED ASSET':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=(h-text_h)/2",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-map_metadata",
      "-1",
      outputPath,
    ]),
  );
}

async function createAc005Foreground(runFfmpeg, fixtureRoot) {
  const outputPath = path.join(fixtureRoot, "generated", "ac005-foreground.png");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await runFfmpeg(ffmpegArgs([
    "-f", "lavfi", "-i", "color=c=black@0:size=1920x1080:rate=1:duration=1",
    "-vf",
    "format=rgba,drawbox=x=0:y=0:w=1920:h=92:color=0x14202BCC:t=fill:replace=1," +
      "drawbox=x=0:y=988:w=1920:h=92:color=0x14202BCC:t=fill:replace=1," +
      "drawbox=x=70:y=28:w=430:h=36:color=0xF2B84BCC:t=fill:replace=1," +
      "drawbox=x=1420:y=1016:w=430:h=36:color=0x73D8B4CC:t=fill:replace=1",
    "-frames:v", "1", "-threads", "1", "-map_metadata", "-1", outputPath,
  ]));
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
    "generated/frozen-overlay.png": { frozen: true, height: 360, width: 640 },
    "generated/ac005-foreground.png": { foreground: true, height: 1080, width: 1920 },
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

export function restylePlanningSignalsFixture() {
  return {
    schema: "guyditor.restyle-signals/v1",
    sourceAssetId: "ast_bbbbbbbbbb",
    fps: "30/1",
    vadSilences: [
      { startFrame: 90, endFrame: 114 },
      { startFrame: 270, endFrame: 306 },
      { startFrame: 465, endFrame: 480 },
    ],
    lowMotionFrames: [102, 288, 473],
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
  const projects = await buildProjectManifest(fixtureRoot);
  totalBytes += Object.values(projects).flatMap(({ files: entries }) =>
    Object.values(entries)).reduce((total, entry) => total + entry.bytes, 0);
  if (totalBytes >= MAX_FIXTURE_BYTES) {
    throw new Error(
      `Fixture outputs total ${totalBytes} bytes; limit is ${MAX_FIXTURE_BYTES - 1}.`,
    );
  }
  return {
    ffmpegVersion: ffmpeg.version,
    files,
    generatorVersion: FIXTURE_GENERATOR_VERSION,
    projects,
  };
}

async function listFiles(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child.split(path.sep).join("/"));
  }
  return files;
}

async function buildProjectManifest(fixtureRoot) {
  const projects = {};
  for (const name of REQUIRED_PROJECT_TEMPLATES) {
    const root = path.join(fixtureRoot, "projects", name);
    const files = {};
    for (const relativePath of await listFiles(root)) {
      const absolutePath = path.join(root, relativePath);
      const fileStat = await stat(absolutePath);
      files[relativePath] = {
        bytes: fileStat.size,
        sha256: await sha256(absolutePath),
      };
    }
    projects[name] = {
      files,
      groundTruth: {
        annotationCount: name === "annotated" ? 1 : 0,
        exactFrame: name === "annotated" ? { frames: 90, fps: "30/1" } : null,
        primaryDeliverableId: "dlv_aaaaaaaaaa",
        revision: "rev_00001",
        schemaValid: true,
        sequenceId: "seq_aaaaaaaaaa",
        transcriptAssetId: "ast_bbbbbbbbbb",
      },
    };
  }
  return projects;
}

async function fixtureAsset(fixtureRoot, relativePath, descriptor) {
  const absolutePath = path.join(fixtureRoot, relativePath);
  const fileStat = await stat(absolutePath);
  return {
    ...descriptor,
    path: absolutePath,
    sha256: await sha256(absolutePath),
    bytes: fileStat.size,
    integrity: "ok",
    ingest: {
      at: FIXED_CREATED_AT,
      ffprobeVersion: "fixture-validated",
      via: descriptor.kind === "generated" ? "generated" : "manual",
    },
  };
}

async function projectAssets(fixtureRoot) {
  return Promise.all([
    fixtureAsset(fixtureRoot, "bars-1080p30-10s.mp4", {
      id: "ast_aaaaaaaaaa", kind: "video", container: "mov,mp4,m4a,3gp,3g2,mj2",
      probe: { duration: { frames: 300, fps: "30/1" }, width: 1920, height: 1080, fps: "30/1", audio: { rate: 48_000, channels: 1 } },
      video: { codec: "h264", width: 1920, height: 1080, fps: "30/1", pixFmt: "yuv420p", hasAlpha: false, rotation: 0 },
      audio: [{ index: 1, codec: "aac", sampleRate: 48_000, channels: 1, layout: "mono" }],
    }),
    fixtureAsset(fixtureRoot, "speech-48k-20s.wav", {
      id: "ast_bbbbbbbbbb", kind: "audio", container: "wav",
      probe: { duration: { samples: 960_000, rate: 48_000 }, audio: { rate: 48_000, channels: 1 } },
      audio: [{ index: 0, codec: "pcm_s16le", sampleRate: 48_000, channels: 1, layout: "mono" }],
    }),
    fixtureAsset(fixtureRoot, "greenscreen-720p30-6s.mp4", {
      id: "ast_cccccccccc", kind: "video", container: "mov,mp4,m4a,3gp,3g2,mj2",
      probe: { duration: { frames: 180, fps: "30/1" }, width: 1280, height: 720, fps: "30/1" },
      video: { codec: "h264", width: 1280, height: 720, fps: "30/1", pixFmt: "yuv420p", hasAlpha: false, rotation: 0 },
    }),
    fixtureAsset(fixtureRoot, "screencast-1080p30-15s.mp4", {
      id: "ast_dddddddddd", kind: "video", container: "mov,mp4,m4a,3gp,3g2,mj2",
      probe: { duration: { frames: 450, fps: "30/1" }, width: 1920, height: 1080, fps: "30/1" },
      video: { codec: "h264", width: 1920, height: 1080, fps: "30/1", pixFmt: "yuv420p", hasAlpha: false, rotation: 0 },
    }),
    fixtureAsset(fixtureRoot, "avsync-video.mp4", {
      id: "ast_eeeeeeeeee", kind: "video", container: "mov,mp4,m4a,3gp,3g2,mj2",
      probe: { duration: { frames: 150, fps: "30/1" }, width: 1280, height: 720, fps: "30/1", audio: { rate: 48_000, channels: 1 } },
      video: { codec: "h264", width: 1280, height: 720, fps: "30/1", pixFmt: "yuv420p", hasAlpha: false, rotation: 0 },
      audio: [{ index: 1, codec: "aac", sampleRate: 48_000, channels: 1, layout: "mono" }],
    }),
    fixtureAsset(fixtureRoot, "avsync-audio.wav", {
      id: "ast_ffffffffff", kind: "audio", container: "wav",
      probe: { duration: { samples: 240_000, rate: 48_000 }, audio: { rate: 48_000, channels: 1 } },
      audio: [{ index: 0, codec: "pcm_s16le", sampleRate: 48_000, channels: 1, layout: "mono" }],
    }),
    fixtureAsset(fixtureRoot, "stills/diagram-1080.png", {
      id: "ast_gggggggggg", kind: "image", container: "png_pipe",
      probe: { width: 1920, height: 1080 }, image: { width: 1920, height: 1080, hasAlpha: false },
    }),
    fixtureAsset(fixtureRoot, "stills/logo-256.png", {
      id: "ast_hhhhhhhhhh", kind: "image", container: "png_pipe",
      probe: { width: 256, height: 256 }, image: { width: 256, height: 256, hasAlpha: false },
    }),
    fixtureAsset(fixtureRoot, "disc-track-720p30-8s.mp4", {
      id: "ast_iiiiiiiiii", kind: "video", container: "mov,mp4,m4a,3gp,3g2,mj2",
      probe: { duration: { frames: 240, fps: "30/1" }, width: 1280, height: 720, fps: "30/1" },
      video: { codec: "h264", width: 1280, height: 720, fps: "30/1", pixFmt: "yuv420p", hasAlpha: false, rotation: 0 },
    }),
    fixtureAsset(fixtureRoot, "generated/frozen-overlay.png", {
      id: "ast_jjjjjjjjjj", kind: "generated", container: "png_pipe",
      probe: { width: 640, height: 360 }, image: { width: 640, height: 360, hasAlpha: false },
      provenance: { sidecar: "generation-frozen" },
    }),
    fixtureAsset(fixtureRoot, "generated/ac005-foreground.png", {
      id: "ast_kkkkkkkkkk", kind: "image", container: "png_pipe",
      probe: { width: 1920, height: 1080 }, image: { width: 1920, height: 1080, hasAlpha: true },
    }),
  ]);
}

function annotationSidecar(annotated) {
  return {
    format: "guyditor.annotations/v1",
    annotations: annotated ? [{
      id: "ann_aaaaaaaaaa",
      shape: "rect",
      body: "Tighten the pacing at this exact frame",
      style: { color: "#f2b84b", strokeWidth: 0.004 },
      geometry: { kind: "rect", origin: { x: 0.2, y: 0.2 }, size: { x: 0.35, y: 0.3 } },
      anchor: { kind: "timeline", sequenceId: "seq_aaaaaaaaaa", frame: { frames: 90, fps: "30/1" } },
      extent: { frames: 0, fps: "30/1" },
      canvasRef: { sequenceId: "seq_aaaaaaaaaa", deliverableId: "dlv_aaaaaaaaaa", aspect: "16:9" },
      state: "open",
      blocking: false,
      author: { kind: "human", id: "fixture" },
      createdAt: FIXED_CREATED_AT,
      history: [],
    }] : [],
  };
}

async function createProjectTemplate(core, transcriptDomain, fixtureRoot, name) {
  if (name === "assembly") {
    await createAssemblyProjectTemplate(core, transcriptDomain, fixtureRoot);
    return;
  }
  if (name === "ac006") {
    await createAc006ProjectTemplate(core, transcriptDomain, fixtureRoot);
    return;
  }
  if (name === "ac005") {
    await createAc005ProjectTemplate(core, fixtureRoot);
    return;
  }
  if (name === "ac003") {
    await createAc003ProjectTemplate(core, fixtureRoot);
    return;
  }
  const root = path.join(fixtureRoot, "projects", name);
  const annotated = name === "annotated";
  const assets = await projectAssets(fixtureRoot);
  const transcript = makeTranscriptFixture({
    assetId: "ast_bbbbbbbbbb",
    durationSamples: 960_000,
    seed: 0x4d_31,
    wordCount: 40,
  });
  const annotations = core.serializeAnnotationSidecar(annotationSidecar(annotated));
  const generation = `${JSON.stringify({
    format: "guyditor.generated-provenance/v1",
    assetId: "ast_jjjjjjjjjj",
    frozen: true,
    generator: { name: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION },
  }, null, 2)}\n`;
  const transcriptText = `${JSON.stringify(transcript, null, 2)}\n`;
  const restyleSignals = `${JSON.stringify(restylePlanningSignalsFixture(), null, 2)}\n`;
  const model = {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: { id: "prj_aaaaaaaaaa", name: `M1 ${name} template`, created: FIXED_CREATED_AT },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 41 },
    assets,
    beats: [],
    sequences: [{
      id: "seq_aaaaaaaaaa",
      name: "main",
      clips: [
        { id: "clp_aaaaaaaaaa", asset: "ast_aaaaaaaaaa", source: { in: { frames: 0, fps: "30/1" }, out: { frames: 120, fps: "30/1" } } },
        { id: "clp_bbbbbbbbbb", asset: "ast_dddddddddd", source: { in: { frames: 225, fps: "30/1" }, out: { frames: 345, fps: "30/1" } } },
        { id: "clp_cccccccccc", asset: "ast_eeeeeeeeee", source: { in: { frames: 0, fps: "30/1" }, out: { frames: 90, fps: "30/1" } } },
        { id: "clp_dddddddddd", asset: "ast_cccccccccc", source: { in: { frames: 30, fps: "30/1" }, out: { frames: 120, fps: "30/1" } } },
      ],
    }],
    layers: [
      { id: "lyr_aaaaaaaaaa", kind: "video", name: "Video + source audio", order: 0, enabled: true, locked: false, sequence: "seq_aaaaaaaaaa" },
      { id: "lyr_bbbbbbbbbb", kind: "audio", name: "Speech reference", order: 1, enabled: false, locked: false, sequence: "seq_aaaaaaaaaa" },
      { id: "lyr_cccccccccc", kind: "image", name: "Review overlay", order: 2, enabled: false, locked: false, sequence: "seq_aaaaaaaaaa" },
    ],
    captions: [],
    annotations: { sidecar: "annotations", summary: { open: annotated ? 1 : 0, resolved: 0, rejected: 0, reopened: 0 } },
    deliverables: [{
      id: "dlv_aaaaaaaaaa", kind: "longform", name: "primary", profile: "youtube-longform@1.0.0",
      sequenceId: "seq_aaaaaaaaaa", status: "approved", approvedRevision: "rev_00001",
    }],
    presets: [],
    skills: [],
    sidecars: [
      { name: "annotations", path: "sidecars/annotations.yaml", schema: "guyditor.annotations/v1", sha256: createHash("sha256").update(annotations).digest("hex"), inputs: [] },
      { name: "generation-frozen", path: "sidecars/generated-frozen.json", schema: "guyditor.generated-provenance/v1", sha256: createHash("sha256").update(generation).digest("hex"), generatedBy: { tool: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION }, inputs: [{ asset: "ast_hhhhhhhhhh", sha256: assets.find(({ id }) => id === "ast_hhhhhhhhhh").sha256 }] },
      { name: "transcript-speech", path: "sidecars/transcript-speech.json", schema: "guyditor.transcript/v1", sha256: createHash("sha256").update(transcriptText).digest("hex"), generatedBy: { tool: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION, job: "job_fixturezzz" }, inputs: [{ asset: "ast_bbbbbbbbbb", sha256: assets.find(({ id }) => id === "ast_bbbbbbbbbb").sha256 }] },
      { name: "restyle-signals", path: "sidecars/analysis/restyle-signals.json", schema: "guyditor.restyle-signals/v1", sha256: createHash("sha256").update(restyleSignals).digest("hex"), generatedBy: { tool: "@guyditor/media", version: "1", job: "job_fixturezzz" }, inputs: [{ asset: "ast_bbbbbbbbbb", sha256: assets.find(({ id }) => id === "ast_bbbbbbbbbb").sha256 }] },
    ],
  };
  const created = await core.createProject(root, model, {
    appVersion: "0.0.0-fixtures",
    idFactory: (prefix) => `${prefix}_fixturezzz`,
    now: () => new Date(FIXED_CREATED_AT),
  });
  if (!created.ok) throw created.error;
  await mkdir(path.join(root, "sidecars/analysis"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "sidecars/annotations.yaml"), annotations),
    writeFile(path.join(root, "sidecars/generated-frozen.json"), generation),
    writeFile(path.join(root, "sidecars/transcript-speech.json"), transcriptText),
    writeFile(path.join(root, "sidecars/analysis/restyle-signals.json"), restyleSignals),
  ]);
}

async function createAc005ProjectTemplate(core, fixtureRoot) {
  const root = path.join(fixtureRoot, "projects", "ac005");
  const allAssets = await projectAssets(fixtureRoot);
  const ids = new Set(["ast_aaaaaaaaaa", "ast_cccccccccc", "ast_kkkkkkkkkk"]);
  const assets = allAssets.filter(({ id }) => ids.has(id));
  const annotations = core.serializeAnnotationSidecar(annotationSidecar(false));
  const generation = `${JSON.stringify({
    format: "guyditor.generated-provenance/v1",
    assetId: "ast_kkkkkkkkkk",
    frozen: true,
    generator: { name: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION },
  }, null, 2)}\n`;
  const transcriptText = `${JSON.stringify(makeTranscriptFixture({
    assetId: "ast_cccccccccc",
    durationSamples: 288_000,
    seed: 0xac_005,
    wordCount: 12,
  }), null, 2)}\n`;
  const arrangement = `${JSON.stringify({
    format: "guyditor.presenter-arrangement/v1",
    id: "pre_dddddddddd",
    name: "presenter_sandwich",
    version: 1,
    layerOrder: ["background", "presenter", "foreground"],
  }, null, 2)}\n`;
  const model = {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: { id: "prj_aaaaaaaaaa", name: "M2 AC-005 keyed presenter sandwich", created: FIXED_CREATED_AT },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 13 },
    assets,
    beats: [],
    sequences: [{
      id: "seq_aaaaaaaaaa",
      name: "presenter",
      clips: [{
        id: "clp_aaaaaaaaaa",
        asset: "ast_cccccccccc",
        source: { in: { frames: 0, fps: "30/1" }, out: { frames: 180, fps: "30/1" } },
        effects: [{
          id: "fx_aaaaaaaaaa",
          kind: "key",
          params: {
            schema: "guyditor/key@1",
            mode: "chroma",
            chroma: {
              keyColor: "#00B140",
              tolerance: 0.35,
              softness: 0.12,
              preBlur: 1.5,
              edge: { erodePx: 1, featherPx: 2 },
              spill: { mode: "despill", strength: 0.7 },
            },
            masks: [],
          },
        }],
      }],
    }],
    layers: [{
      id: "lyr_aaaaaaaaaa", kind: "video", name: "background", order: 0,
      enabled: true, locked: false, items: [{
        id: "clp_bbbbbbbbbb", asset: "ast_aaaaaaaaaa", at: "timeline:seq_aaaaaaaaaa@0",
        duration: { frames: 180, fps: "30/1" },
        source: { in: { frames: 0, fps: "30/1" }, out: { frames: 180, fps: "30/1" } },
      }],
    }, {
      id: "lyr_bbbbbbbbbb", kind: "video", name: "presenter", order: 10,
      enabled: true, locked: false, sequence: "seq_aaaaaaaaaa",
      transform: {
        anchor: { x: 0.5, y: 0.5 }, position: { x: 0.5, y: 0.5 },
        scale: { x: 1.5, y: 1.5 }, rotationDeg: 0,
      },
    }, {
      id: "lyr_cccccccccc", kind: "image", name: "foreground", order: 20,
      enabled: true, locked: false, items: [{
        id: "clp_cccccccccc", asset: "ast_kkkkkkkkkk", at: "timeline:seq_aaaaaaaaaa@0",
        duration: { frames: 180, fps: "30/1" },
      }],
    }],
    captions: [],
    annotations: { sidecar: "annotations", summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 } },
    deliverables: [{
      id: "dlv_aaaaaaaaaa", kind: "longform", name: "AC-005 composite",
      profile: "youtube-longform@1.0.0", sequenceId: "seq_aaaaaaaaaa", status: "draft",
    }],
    presets: [{
      id: "pre_dddddddddd", name: "presenter_sandwich", kind: "layout", version: 1,
      path: "presets/pre_dddddddddd@1.json",
      sha256: createHash("sha256").update(arrangement).digest("hex"),
    }],
    skills: [],
    sidecars: [{
      name: "annotations", path: "sidecars/annotations.yaml", schema: "guyditor.annotations/v1",
      sha256: createHash("sha256").update(annotations).digest("hex"), inputs: [],
    }],
  };
  const created = await core.createProject(root, model, {
    appVersion: "0.0.0-fixtures",
    idFactory: (prefix) => `${prefix}_fixturezzz`,
    now: () => new Date(FIXED_CREATED_AT),
  });
  if (!created.ok) throw created.error;
  await Promise.all([
    mkdir(path.join(root, "presets"), { recursive: true }),
    writeFile(path.join(root, "sidecars/annotations.yaml"), annotations),
    writeFile(path.join(root, "sidecars/generated-frozen.json"), generation),
    writeFile(path.join(root, "sidecars/transcript-speech.json"), transcriptText),
  ]);
  await writeFile(path.join(root, "presets/pre_dddddddddd@1.json"), arrangement);
}

async function createAc006ProjectTemplate(core, transcriptDomain, fixtureRoot) {
  const root = path.join(fixtureRoot, "projects", "ac006");
  const allAssets = await projectAssets(fixtureRoot);
  const ids = new Set(["ast_cccccccccc", "ast_dddddddddd"]);
  const assets = allAssets.filter(({ id }) => ids.has(id));
  const annotations = core.serializeAnnotationSidecar(annotationSidecar(false));
  const transcriptText = transcriptDomain.serializeTranscriptSidecar(makeTranscriptFixture({
    assetId: "ast_cccccccccc",
    durationSamples: 288_000,
    seed: 0xac_006,
    wordCount: 123,
  }));
  const generation = `${JSON.stringify({
    format: "guyditor.generated-provenance/v1",
    frozen: true,
    generator: { name: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION },
  }, null, 2)}\n`;
  const model = {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: { id: "prj_aaaaaaaaaa", name: "M2 AC-006 semantic picture in picture", created: FIXED_CREATED_AT },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 124 },
    assets,
    beats: [],
    sequences: [{
      id: "seq_aaaaaaaaaa",
      name: "presenter",
      clips: [{
        id: "clp_aaaaaaaaaa",
        asset: "ast_cccccccccc",
        source: { in: { frames: 0, fps: "30/1" }, out: { frames: 180, fps: "30/1" } },
        effects: [{
          id: "fx_aaaaaaaaaa",
          kind: "key",
          params: {
            schema: "guyditor/key@1", mode: "chroma",
            chroma: {
              keyColor: "#00B140", tolerance: 0.35, softness: 0.12, preBlur: 1.5,
              edge: { erodePx: 1, featherPx: 2 },
              spill: { mode: "despill", strength: 0.7 },
            },
            masks: [],
          },
        }],
      }],
    }],
    layers: [{
      id: "lyr_aaaaaaaaaa", kind: "video", name: "screencast", order: 0,
      enabled: true, locked: false, items: [{
        id: "clp_bbbbbbbbbb", asset: "ast_dddddddddd", at: "timeline:seq_aaaaaaaaaa@0",
        duration: { frames: 180, fps: "30/1" },
        source: { in: { frames: 0, fps: "30/1" }, out: { frames: 180, fps: "30/1" } },
      }],
    }, {
      id: "lyr_bbbbbbbbbb", kind: "video", name: "presenter", order: 10,
      enabled: true, locked: false, sequence: "seq_aaaaaaaaaa",
      pip: {
        style: {
          mask: { shape: "rounded", cornerRadius: 0.08 },
          border: { widthPx: 4, color: "#FFFFFF", opacity: 0.9 },
          shadow: { dx: 0, dy: 8, blurPx: 24, color: "#000000", opacity: 0.35 },
        },
        placement: { base: { anchor: "bottom_right", width: "24%", margin: "4%", aspect: "16:9" } },
        keyframes: [],
      },
    }],
    captions: [],
    annotations: { sidecar: "annotations", summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 } },
    deliverables: [{
      id: "dlv_aaaaaaaaaa", kind: "longform", name: "AC-006 PiP",
      profile: "youtube-longform@1.0.0", sequenceId: "seq_aaaaaaaaaa", status: "draft",
    }],
    presets: [],
    skills: [],
    sidecars: [{
      name: "annotations", path: "sidecars/annotations.yaml", schema: "guyditor.annotations/v1",
      sha256: createHash("sha256").update(annotations).digest("hex"), inputs: [],
    }, {
      name: "transcript-speech", path: "sidecars/transcript-speech.json", schema: "guyditor.transcript/v1",
      sha256: createHash("sha256").update(transcriptText).digest("hex"),
      generatedBy: { tool: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION, job: "job_fixturezzz" },
      inputs: [{ asset: "ast_cccccccccc", sha256: assets.find(({ id }) => id === "ast_cccccccccc").sha256 }],
    }],
  };
  const created = await core.createProject(root, model, {
    appVersion: "0.0.0-fixtures",
    idFactory: (prefix) => `${prefix}_fixturezzz`,
    now: () => new Date(FIXED_CREATED_AT),
  });
  if (!created.ok) throw created.error;
  await Promise.all([
    writeFile(path.join(root, "sidecars/annotations.yaml"), annotations),
    writeFile(path.join(root, "sidecars/generated-frozen.json"), generation),
    writeFile(path.join(root, "sidecars/transcript-speech.json"), transcriptText),
  ]);
}

function ac003CaptionPreset() {
  return {
    format: "guyditor.caption-preset/v1",
    presetId: "pre_aaaaaaaaaa",
    name: "AC-003 deterministic captions",
    version: 1,
    style: {
      typeface: { family: "Inconsolata Guyditor", fontAssetId: "font_inconsolata_001010", fallbackAssetIds: [] },
      sizePct: 5.2,
      weight: 700,
      italic: false,
      letterSpacingPct: 0,
      lineSpacing: 1.08,
      color: "#FFFFFFFF",
      outline: { color: "#000000FF", widthPct: 0.45 },
      shadow: { color: "#00000099", dxPct: 0.18, dyPct: 0.24, blurPct: 0.18 },
      background: null,
      transform: "none",
      wordsPerLine: 4,
      maxLines: 2,
      maxWidthPct: 90,
      placement: { anchor: "bottom", offsetYPct: -5, align: "center" },
      safeArea: "platform",
      highlight: {
        mode: "per-word", style: "color", color: "#F2B84BFF", pastWords: "keep",
        maxGapMs: 400, holdMs: 0, leadInMs: 0,
      },
      emphasisStyle: { style: "scale", scale: 1.08 },
      cueGapMs: 800,
      maxCueDurationMs: 7_000,
      speakerStyles: {},
    },
  };
}

async function createAc003ProjectTemplate(core, fixtureRoot) {
  const root = path.join(fixtureRoot, "projects", "ac003");
  const assets = await projectAssets(fixtureRoot);
  const speech = assets.find(({ id }) => id === "ast_bbbbbbbbbb");
  if (speech === undefined) throw new Error("AC-003 speech fixture asset is missing.");
  const transcript = JSON.parse(await readFile(
    path.join(fixtureRoot, "transcripts/drift-2800w-20m.json"),
    "utf8",
  ));
  transcript.assetId = speech.id;
  const transcriptText = `${JSON.stringify(transcript, null, 2)}\n`;
  const annotations = core.serializeAnnotationSidecar(annotationSidecar(false));
  const generation = `${JSON.stringify({
    format: "guyditor.generated-provenance/v1",
    assetId: "ast_jjjjjjjjjj",
    frozen: true,
    generator: { name: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION },
  }, null, 2)}\n`;
  const presetText = `${JSON.stringify(ac003CaptionPreset(), null, 2)}\n`;
  const model = {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: { id: "prj_aaaaaaaaaa", name: "M2 AC-003 caption correction", created: FIXED_CREATED_AT },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 2_801 },
    assets: [speech],
    beats: [],
    sequences: [{
      id: "seq_aaaaaaaaaa",
      name: "speech-backed captions",
      clips: [{
        id: "clp_aaaaaaaaaa",
        asset: speech.id,
        source: {
          in: { frames: 0, fps: "30/1" },
          out: { frames: 600, fps: "30/1" },
        },
      }],
    }],
    layers: [{
      id: "lyr_aaaaaaaaaa",
      kind: "video",
      name: "Speech with deterministic black visual",
      order: 0,
      enabled: true,
      locked: false,
      sequence: "seq_aaaaaaaaaa",
    }],
    captions: [{
      id: "cts_aaaaaaaaaa",
      name: "AC-003 captions",
      sourceLayerIds: ["lyr_aaaaaaaaaa"],
      preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
      styleOverrides: {},
      breakOverrides: [],
      emphasisOverrides: [],
      timingOffsets: [],
      enabled: true,
    }],
    annotations: { sidecar: "annotations", summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 } },
    deliverables: [{
      id: "dlv_aaaaaaaaaa",
      kind: "longform",
      name: "AC-003 primary",
      profile: "youtube-longform@1.0.0",
      sequenceId: "seq_aaaaaaaaaa",
      captionsTrackId: "cts_aaaaaaaaaa",
      status: "draft",
    }],
    presets: [{
      id: "pre_aaaaaaaaaa",
      name: "AC-003 deterministic captions",
      kind: "caption",
      version: 1,
      path: "presets/pre_aaaaaaaaaa@1.yaml",
      sha256: createHash("sha256").update(presetText).digest("hex"),
    }],
    skills: [],
    sidecars: [
      { name: "annotations", path: "sidecars/annotations.yaml", schema: "guyditor.annotations/v1", sha256: createHash("sha256").update(annotations).digest("hex"), inputs: [] },
      { name: "transcript-speech", path: "sidecars/transcript-speech.json", schema: "guyditor.transcript/v1", sha256: createHash("sha256").update(transcriptText).digest("hex"), generatedBy: { tool: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION, job: "job_fixturezzz" }, inputs: [{ asset: speech.id, sha256: speech.sha256 }] },
    ],
  };
  const created = await core.createProject(root, model, {
    appVersion: "0.0.0-fixtures",
    idFactory: (prefix) => `${prefix}_fixturezzz`,
    now: () => new Date(FIXED_CREATED_AT),
  });
  if (!created.ok) throw created.error;
  await Promise.all([
    mkdir(path.join(root, "presets"), { recursive: true }),
    writeFile(path.join(root, "sidecars/annotations.yaml"), annotations),
    writeFile(path.join(root, "sidecars/generated-frozen.json"), generation),
    writeFile(path.join(root, "sidecars/transcript-speech.json"), transcriptText),
  ]);
  await writeFile(path.join(root, "presets/pre_aaaaaaaaaa@1.yaml"), presetText);
}

const ASSEMBLY_WORD_MS = 300;
const ASSEMBLY_WORD_GAP_MS = 80;
const ASSEMBLY_LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Scripted transcript: one segment per utterance, 300 ms per word, 80 ms gap, confidence 0.95. */
export function makeScriptedTranscriptFixture({
  assetId,
  rate = SAMPLE_RATE,
  utterances,
  wordOrdinalStart = 1,
}) {
  const at = (ms) => ({ rate, samples: Math.round((ms * rate) / 1000) });
  const words = {};
  let ordinal = wordOrdinalStart;
  const segments = utterances.map((utterance, index) => {
    const ids = utterance.text.split(/\s+/u).filter(Boolean).map((text, position) => {
      const id = `w${String(ordinal).padStart(6, "0")}`;
      ordinal += 1;
      const startMs = utterance.atMs + position * (ASSEMBLY_WORD_MS + ASSEMBLY_WORD_GAP_MS);
      words[id] = {
        alignment: "ctc",
        confidence: 0.95,
        end: at(startMs + ASSEMBLY_WORD_MS),
        origin: "asr",
        punctAfter: "",
        punctBefore: "",
        start: at(startMs),
        state: "active",
        text,
      };
      return id;
    });
    return {
      end: words[ids.at(-1)].end,
      id: `seg_assembly${ASSEMBLY_LETTERS[index]}a`,
      language: "en",
      speaker: "spk_assemblyaa",
      start: words[ids[0]].start,
      words: ids,
    };
  });
  return {
    assetId,
    audio: { channels: 1, rate, streamIndex: 0 },
    language: "en",
    languageProbability: 1,
    provenance: {
      alignment: null,
      createdAt: FIXED_CREATED_AT,
      engine: { model: "scripted", name: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION },
      jobId: "job_fixturezzz",
    },
    schema: "guyditor.transcript/v1",
    segments,
    speakers: [{ id: "spk_assemblyaa", label: "Speaker 1" }],
    words,
  };
}

const ASSEMBLY_LINE_ONE = "Could AI talk you into the dumbest decision of your life";
const ASSEMBLY_CLIPS = [
  { id: "ast_assemblyaa", file: "cam_01.mp4", offsetSeconds: 0, source: "screencast-1080p30-15s.mp4", frames: 450, utterances: [
    { atMs: 500, text: ASSEMBLY_LINE_ONE },
    { atMs: 6300, text: "again" },
    { atMs: 8300, text: ASSEMBLY_LINE_ONE },
  ] },
  { id: "ast_assemblyab", file: "cam_02.mp4", offsetSeconds: 40, source: "bars-1080p30-10s.mp4", frames: 300, utterances: [
    { atMs: 500, text: "Your gut says no mine did too" },
  ] },
  { id: "ast_assemblyac", file: "cam_03.mp4", offsetSeconds: 90, source: "bars-1080p30-10s.mp4", frames: 300, utterances: [
    { atMs: 500, text: "Then I read a medical case from Switzerland" },
  ] },
];
const ASSEMBLY_SCRIPT = [
  "# Assembly fixture",
  "",
  "## 1. Hook",
  "",
  `> ${ASSEMBLY_LINE_ONE}`,
  ">",
  "> Your gut says no mine did too",
  ">",
  "> Then I read a medical case from Switzerland",
  "",
].join("\n");

async function createAssemblyProjectTemplate(core, transcriptDomain, fixtureRoot) {
  const root = path.join(fixtureRoot, "projects", "assembly");
  await mkdir(path.join(root, "media"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "scripts/assembly.raw.md"), ASSEMBLY_SCRIPT);
  const base = Date.parse("2026-10-20T10:00:00Z");
  const assets = [];
  for (const clip of ASSEMBLY_CLIPS) {
    await copyFile(path.join(fixtureRoot, clip.source), path.join(root, "media", clip.file));
    const asset = await fixtureAsset(root, `media/${clip.file}`, {
      id: clip.id, kind: "video", container: "mov,mp4,m4a,3gp,3g2,mj2",
      probe: { duration: { frames: clip.frames, fps: "30/1" }, width: 1920, height: 1080, fps: "30/1", ...(clip.frames === 300 ? { audio: { rate: 48_000, channels: 1 } } : {}) },
      video: { codec: "h264", width: 1920, height: 1080, fps: "30/1", pixFmt: "yuv420p", hasAlpha: false, rotation: 0 },
      ...(clip.frames === 300 ? { audio: [{ index: 1, codec: "aac", sampleRate: 48_000, channels: 1, layout: "mono" }] } : {}),
      captureTime: { value: new Date(base + clip.offsetSeconds * 1000).toISOString().replace(".000", ""), source: "container" },
    });
    asset.path = `media/${clip.file}`;
    assets.push(asset);
  }
  const annotations = core.serializeAnnotationSidecar(annotationSidecar(false));
  let ordinal = 1;
  const transcripts = ASSEMBLY_CLIPS.map((clip) => {
    const sidecar = makeScriptedTranscriptFixture({
      assetId: clip.id, utterances: clip.utterances, wordOrdinalStart: ordinal,
    });
    ordinal += Object.keys(sidecar.words).length;
    return { clip, text: transcriptDomain.serializeTranscriptSidecar(sidecar) };
  });
  const model = {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: { id: "prj_aaaaaaaaaa", name: "AI assembly", created: FIXED_CREATED_AT },
    settings: {
      timeline: { fps: "30/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: ordinal },
    assets,
    beats: [],
    sequences: [{ id: "seq_aaaaaaaaaa", name: "main", clips: [] }],
    layers: [{
      id: "lyr_aaaaaaaaaa", kind: "video", name: "a-roll", order: 0,
      enabled: true, locked: false, sequence: "seq_aaaaaaaaaa",
    }],
    captions: [],
    annotations: { sidecar: "annotations", summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 } },
    deliverables: [{
      id: "dlv_aaaaaaaaaa", kind: "longform", name: "Assembly",
      profile: "youtube-longform@1.0.0", sequenceId: "seq_aaaaaaaaaa", status: "draft",
    }],
    presets: [],
    skills: [],
    sidecars: [{
      name: "annotations", path: "sidecars/annotations.yaml", schema: "guyditor.annotations/v1",
      sha256: createHash("sha256").update(annotations).digest("hex"), inputs: [],
    }, ...transcripts.map(({ clip, text }) => ({
      name: `transcript-${clip.id}`,
      path: `sidecars/transcripts/${clip.id}.transcript.json`,
      schema: "guyditor.transcript/v1",
      sha256: createHash("sha256").update(text).digest("hex"),
      generatedBy: { tool: "guyditor-fixture-generator", version: FIXTURE_GENERATOR_VERSION, job: "job_fixturezzz" },
      inputs: [{ asset: clip.id, sha256: assets.find(({ id }) => id === clip.id).sha256 }],
    }))],
  };
  const created = await core.createProject(root, model, {
    appVersion: "0.0.0-fixtures",
    idFactory: (prefix) => `${prefix}_fixturezzz`,
    now: () => new Date(FIXED_CREATED_AT),
  });
  if (!created.ok) throw created.error;
  await mkdir(path.join(root, "sidecars/transcripts"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "sidecars/annotations.yaml"), annotations),
    ...transcripts.map(({ clip, text }) =>
      writeFile(path.join(root, `sidecars/transcripts/${clip.id}.transcript.json`), text)),
  ]);
}

async function createProjectTemplates(core, transcriptDomain, fixtureRoot) {
  for (const name of REQUIRED_PROJECT_TEMPLATES) {
    await createProjectTemplate(core, transcriptDomain, fixtureRoot, name);
  }
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
    "generated/frozen-overlay.png": { height: 360, width: 640 },
    "generated/ac005-foreground.png": { height: 1080, width: 1920 },
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
  await ensureCaptionFont();
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
    const { core, transcript, runFfmpeg, runFfprobe } = mediaRuntime;
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
      ["frozen generated overlay", () => createFrozenOverlay(runFfmpeg, fixtureRoot)],
      ["AC-005 foreground overlay", () => createAc005Foreground(runFfmpeg, fixtureRoot)],
      ["transcripts", () => createTranscripts(fixtureRoot)],
    ];
    for (const [label, create] of steps) {
      log(`fixtures: generating ${label}`);
      await create();
    }

    log("fixtures: validating media with ffprobe");
    await validateOutputs(runFfprobe, fixtureRoot);
    log("fixtures: building schema-valid project templates through @guyditor/core");
    await createProjectTemplates(core, transcript, fixtureRoot);
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
      "fixtures: wrote basic, annotated, AC-003, AC-005, and AC-006 project templates",
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
