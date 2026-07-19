import type { SeededRng } from "./template-contract.js";

function rotateLeft(value: number, places: number): number {
  return ((value << places) | (value >>> (32 - places))) >>> 0;
}

function splitMix32(value: number): number {
  let mixed = (value + 0x9e37_79b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0_aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a_2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

export function createSeededRng(seed: number): SeededRng {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Template seed must be a uint32.");
  }
  let value = seed >>> 0;
  const state = new Uint32Array(4);
  for (let index = 0; index < state.length; index += 1) {
    value = splitMix32(value);
    state[index] = value;
  }
  if ((state[0]! | state[1]! | state[2]! | state[3]!) === 0) state[0] = 1;

  const nextUint32 = (): number => {
    const result = Math.imul(rotateLeft(Math.imul(state[1]!, 5), 7), 9) >>> 0;
    const temporary = (state[1]! << 9) >>> 0;
    state[2] = (state[2]! ^ state[0]!) >>> 0;
    state[3] = (state[3]! ^ state[1]!) >>> 0;
    state[1] = (state[1]! ^ state[2]!) >>> 0;
    state[0] = (state[0]! ^ state[3]!) >>> 0;
    state[2] = (state[2]! ^ temporary) >>> 0;
    state[3] = rotateLeft(state[3]!, 11);
    return result;
  };

  return Object.freeze({
    nextUint32,
    next: () => nextUint32() / 0x1_0000_0000,
    int: (minimum: number, maximum: number): number => {
      if (
        !Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) ||
        maximum < minimum
      ) {
        throw new RangeError("SeededRng.int requires an ordered safe-integer range.");
      }
      const span = maximum - minimum + 1;
      if (!Number.isSafeInteger(span) || span > 0x1_0000_0000) {
        throw new RangeError("SeededRng.int range must contain at most 2^32 values.");
      }
      return minimum + Math.floor(nextUint32() / 0x1_0000_0000 * span);
    },
  });
}
