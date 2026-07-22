export function laplacianVariance(
  grayscale: Uint8Array,
  width: number,
  height: number,
): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 3 || height < 3) {
    throw new RangeError("Sharpness dimensions must be integers of at least 3×3.");
  }
  if (grayscale.length !== width * height) {
    throw new RangeError(
      `Grayscale frame has ${String(grayscale.length)} bytes; expected ${String(width * height)}.`,
    );
  }
  let total = 0;
  let squared = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const value = 4 * grayscale[index]! - grayscale[index - 1]! - grayscale[index + 1]! -
        grayscale[index - width]! - grayscale[index + width]!;
      total += value;
      squared += value * value;
      count += 1;
    }
  }
  const mean = total / count;
  return squared / count - mean * mean;
}
