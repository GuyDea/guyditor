import { spawnSync } from "node:child_process";

import { resolveFfmpeg } from "../../../media/src/index.js";

export function hammingDistance(left: string, right: string): number {
  if (!/^[0-9a-f]{16}$/u.test(left) || !/^[0-9a-f]{16}$/u.test(right)) {
    throw new TypeError("dHash values must be 16 lowercase hexadecimal characters.");
  }
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits !== 0n) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance;
}

export function dhashFrame(filePath: string, frame: number): string {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError("Golden frame index must be a non-negative safe integer.");
  }
  const ffmpeg = resolveFfmpeg();
  const result = spawnSync(ffmpeg.path, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    filePath,
    "-vf",
    `select=eq(n\\,${String(frame)}),scale=9:8:flags=neighbor,format=gray`,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "pipe:1",
  ], {
    encoding: null,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Could not extract golden frame ${String(frame)}: ${
        result.error?.message ?? result.stderr.toString("utf8")
      }`,
    );
  }
  if (result.stdout.length !== 9 * 8) {
    throw new Error(
      `Golden frame ${String(frame)} produced ${String(result.stdout.length)} grayscale bytes.`,
    );
  }
  let bits = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      bits <<= 1n;
      if (result.stdout[row * 9 + column]! > result.stdout[row * 9 + column + 1]!) {
        bits |= 1n;
      }
    }
  }
  return bits.toString(16).padStart(16, "0");
}
