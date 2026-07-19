import type {
  AnnotationGeometry,
  NormPoint,
} from "./types.js";

const SPATIAL_SCALE = 1_000_000;
const FREEHAND_EPSILON = 0.002;
const FREEHAND_MAX_POINTS = 512;

interface RasterSize {
  width: number;
  height: number;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
  return value;
}

function raster(size: RasterSize): RasterSize {
  if (
    !Number.isFinite(size.width) || !Number.isFinite(size.height) ||
    size.width <= 0 || size.height <= 0
  ) {
    throw new RangeError("Canvas width and height must be finite and positive.");
  }
  return size;
}

export function roundSpatial(value: number): number {
  const rounded = Math.round(finite(value, "Spatial value") * SPATIAL_SCALE) /
    SPATIAL_SCALE;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizedPoint(point: NormPoint): NormPoint {
  return { x: roundSpatial(point.x), y: roundSpatial(point.y) };
}

export function normalizeCanvasPoint(
  point: NormPoint,
  size: RasterSize,
): NormPoint {
  const checked = raster(size);
  return normalizedPoint({
    x: finite(point.x, "Pixel x") / checked.width,
    y: finite(point.y, "Pixel y") / checked.height,
  });
}

export function normalizedPointToPixels(
  point: NormPoint,
  size: RasterSize,
): NormPoint {
  const checked = raster(size);
  return {
    x: finite(point.x, "Normalized x") * checked.width,
    y: finite(point.y, "Normalized y") * checked.height,
  };
}

function aspectRatio(aspect: string): number {
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/u.exec(aspect);
  if (match === null) throw new RangeError(`Canvas aspect ${aspect} must be W:H.`);
  return Number(match[1]) / Number(match[2]);
}

function squaredDistanceToSegment(
  point: NormPoint,
  start: NormPoint,
  end: NormPoint,
  aspect: number,
): number {
  const px = point.x * aspect;
  const sx = start.x * aspect;
  const ex = end.x * aspect;
  const dx = ex - sx;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return (px - sx) ** 2 + (point.y - start.y) ** 2;
  }
  const projected = Math.max(0, Math.min(1,
    ((px - sx) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return (px - (sx + projected * dx)) ** 2 +
    (point.y - (start.y + projected * dy)) ** 2;
}

function simplifyRdp(
  points: readonly NormPoint[],
  epsilon: number,
  aspect: number,
): NormPoint[] {
  if (points.length <= 2) return points.map(normalizedPoint);
  let greatestDistance = -1;
  let greatestIndex = 0;
  const first = points[0]!;
  const last = points.at(-1)!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = squaredDistanceToSegment(points[index]!, first, last, aspect);
    if (distance > greatestDistance) {
      greatestDistance = distance;
      greatestIndex = index;
    }
  }
  if (greatestDistance <= epsilon * epsilon) {
    return [normalizedPoint(first), normalizedPoint(last)];
  }
  const left = simplifyRdp(points.slice(0, greatestIndex + 1), epsilon, aspect);
  const right = simplifyRdp(points.slice(greatestIndex), epsilon, aspect);
  return [...left.slice(0, -1), ...right];
}

export function simplifyFreehand(
  points: readonly NormPoint[],
  aspect: string,
): NormPoint[] {
  if (points.length < 2) throw new RangeError("Freehand geometry requires at least two points.");
  const ratio = aspectRatio(aspect);
  let epsilon = FREEHAND_EPSILON;
  let simplified = simplifyRdp(points, epsilon, ratio);
  while (simplified.length > FREEHAND_MAX_POINTS) {
    epsilon *= 2;
    simplified = simplifyRdp(points, epsilon, ratio);
  }
  return simplified;
}

export function normalizeAnnotationGeometry(
  geometry: AnnotationGeometry,
  aspect: string,
): AnnotationGeometry {
  switch (geometry.kind) {
    case "pin":
      return { kind: "pin", at: normalizedPoint(geometry.at) };
    case "rect":
      return {
        kind: "rect",
        origin: normalizedPoint(geometry.origin),
        size: normalizedPoint(geometry.size),
        ...(geometry.rotationDeg === undefined
          ? {}
          : { rotationDeg: finite(geometry.rotationDeg, "Rectangle rotation") }),
      };
    case "ellipse":
      return {
        kind: "ellipse",
        center: normalizedPoint(geometry.center),
        radii: normalizedPoint(geometry.radii),
        ...(geometry.rotationDeg === undefined
          ? {}
          : { rotationDeg: finite(geometry.rotationDeg, "Ellipse rotation") }),
      };
    case "arrow":
      return {
        kind: "arrow",
        from: normalizedPoint(geometry.from),
        to: normalizedPoint(geometry.to),
      };
    case "freehand":
      return {
        kind: "freehand",
        points: simplifyFreehand(geometry.points, aspect),
        closed: geometry.closed,
      };
    case "spotlight":
      return {
        kind: "spotlight",
        region: "rect" in geometry.region
          ? {
              rect: {
                origin: normalizedPoint(geometry.region.rect.origin),
                size: normalizedPoint(geometry.region.rect.size),
              },
            }
          : {
              ellipse: {
                center: normalizedPoint(geometry.region.ellipse.center),
                radii: normalizedPoint(geometry.region.ellipse.radii),
              },
            },
        dimOpacity: roundSpatial(geometry.dimOpacity),
      };
  }
}

interface FitTransform {
  xScale: number;
  yScale: number;
  xOffset: number;
  yOffset: number;
}

function fitTransform(authoredAspect: string, targetAspect: string): FitTransform {
  const authoredWidth = aspectRatio(authoredAspect);
  const targetWidth = aspectRatio(targetAspect);
  const scale = Math.min(targetWidth / authoredWidth, 1);
  const fittedWidth = authoredWidth * scale;
  const fittedHeight = scale;
  return {
    xScale: fittedWidth / targetWidth,
    yScale: fittedHeight,
    xOffset: (targetWidth - fittedWidth) / (2 * targetWidth),
    yOffset: (1 - fittedHeight) / 2,
  };
}

function mapPoint(point: NormPoint, transform: FitTransform): NormPoint {
  return normalizedPoint({
    x: transform.xOffset + point.x * transform.xScale,
    y: transform.yOffset + point.y * transform.yScale,
  });
}

function mapVector(point: NormPoint, transform: FitTransform): NormPoint {
  return normalizedPoint({
    x: point.x * transform.xScale,
    y: point.y * transform.yScale,
  });
}

function mapGeometry(
  geometry: AnnotationGeometry,
  transform: FitTransform,
): AnnotationGeometry {
  switch (geometry.kind) {
    case "pin":
      return { kind: "pin", at: mapPoint(geometry.at, transform) };
    case "rect":
      return {
        kind: "rect",
        origin: mapPoint(geometry.origin, transform),
        size: mapVector(geometry.size, transform),
        ...(geometry.rotationDeg === undefined ? {} : { rotationDeg: geometry.rotationDeg }),
      };
    case "ellipse":
      return {
        kind: "ellipse",
        center: mapPoint(geometry.center, transform),
        radii: mapVector(geometry.radii, transform),
        ...(geometry.rotationDeg === undefined ? {} : { rotationDeg: geometry.rotationDeg }),
      };
    case "arrow":
      return {
        kind: "arrow",
        from: mapPoint(geometry.from, transform),
        to: mapPoint(geometry.to, transform),
      };
    case "freehand":
      return {
        kind: "freehand",
        points: geometry.points.map((point) => mapPoint(point, transform)),
        closed: geometry.closed,
      };
    case "spotlight":
      return {
        kind: "spotlight",
        region: "rect" in geometry.region
          ? {
              rect: {
                origin: mapPoint(geometry.region.rect.origin, transform),
                size: mapVector(geometry.region.rect.size, transform),
              },
            }
          : {
              ellipse: {
                center: mapPoint(geometry.region.ellipse.center, transform),
                radii: mapVector(geometry.region.ellipse.radii, transform),
              },
            },
        dimOpacity: geometry.dimOpacity,
      };
  }
}

export function fitMapGeometry(
  geometry: AnnotationGeometry,
  authoredAspect: string,
  targetAspect: string,
): { geometry: AnnotationGeometry; approximate: boolean } {
  if (authoredAspect === targetAspect) {
    return {
      geometry: normalizeAnnotationGeometry(geometry, authoredAspect),
      approximate: false,
    };
  }
  return {
    geometry: mapGeometry(geometry, fitTransform(authoredAspect, targetAspect)),
    approximate: true,
  };
}
