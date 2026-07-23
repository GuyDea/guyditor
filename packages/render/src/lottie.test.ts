import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as render from "./index.js";

interface LottieAnimation {
  readonly width: number;
  readonly height: number;
}

interface LottieExports {
  createLottieAnimation?: (
    document: unknown,
    rasterAssets?: ReadonlyMap<string, unknown>,
    analysisOptions?: unknown,
  ) => LottieAnimation;
  renderLottiePng?: (
    animation: LottieAnimation,
    options: {
      frame: number;
      width: number;
      height: number;
      colorSlots?: Readonly<Record<string, string>>;
    },
  ) => Buffer;
  lottieToolchainHash?: (shimVersion?: string) => string;
  graphicOverlayToolchain?: (lottieShimVersion?: string) => {
    version: string;
    canvasVersion: string;
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function animationFixture(): Record<string, unknown> {
  const transform = {
    a: { a: 0, k: [0, 0] },
    p: { a: 0, k: [120, 70] },
    s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
  };
  return {
    v: "5.12.2",
    fr: 30,
    ip: 0,
    op: 40,
    w: 240,
    h: 140,
    assets: [{
      id: "pulse",
      w: 80,
      h: 80,
      layers: [{
        ty: 4,
        nm: "Pulse",
        ip: 0,
        op: 40,
        ks: {
          ...transform,
          p: { a: 0, k: [40, 40] },
        },
        masksProperties: [{
          mode: "a",
          inv: false,
          pt: {
            a: 0,
            k: {
              i: [[0, -22], [22, 0], [0, 22], [-22, 0]],
              o: [[0, 22], [-22, 0], [0, -22], [22, 0]],
              v: [[0, -32], [32, 0], [0, 32], [-32, 0]],
              c: true,
            },
          },
          o: { a: 0, k: 100 },
        }],
        shapes: [{
          ty: "gr",
          nm: "Pulse group",
          it: [
            {
              ty: "el",
              nm: "Pulse circle",
              p: { a: 0, k: [0, 0] },
              s: {
                a: 1,
                k: [
                  {
                    t: 0,
                    s: [24, 24],
                    e: [68, 68],
                    o: { x: [0.2], y: [0] },
                  },
                  {
                    t: 30,
                    s: [68, 68],
                    i: { x: [0.8], y: [1] },
                  },
                ],
              },
            },
            {
              ty: "st",
              nm: "outline",
              c: { a: 0, k: [1, 0.42, 0.34, 1] },
              o: { a: 0, k: 100 },
              w: { a: 0, k: 4 },
              lc: 2,
              lj: 2,
            },
            {
              ty: "tm",
              nm: "Reveal",
              s: { a: 0, k: 0 },
              e: {
                a: 1,
                k: [{ t: 0, s: [15], e: [100] }, { t: 30, s: [100] }],
              },
              o: { a: 0, k: 0 },
              m: 1,
            },
            {
              ty: "tr",
              nm: "Pulse transform",
              a: { a: 0, k: [0, 0] },
              p: { a: 0, k: [0, 0] },
              s: { a: 0, k: [100, 100] },
              r: { a: 0, k: 0 },
              o: { a: 0, k: 100 },
            },
          ],
        }],
      }],
    }],
    layers: [{
      ty: 0,
      nm: "Pulse precomp",
      refId: "pulse",
      ip: 0,
      op: 40,
      ks: transform,
    }, {
      ty: 4,
      nm: "Card",
      ip: 0,
      op: 40,
      ks: transform,
      shapes: [{
        ty: "gr",
        nm: "Card group",
        it: [
          {
            ty: "rc",
            nm: "Card rectangle",
            p: { a: 0, k: [0, 0] },
            s: { a: 0, k: [210, 110] },
            r: { a: 0, k: 18 },
          },
          {
            ty: "fl",
            nm: "surface",
            c: { a: 0, k: [0.06, 0.16, 0.26, 1] },
            o: { a: 0, k: 100 },
          },
          {
            ty: "tr",
            nm: "Card transform",
            a: { a: 0, k: [0, 0] },
            p: { a: 0, k: [0, 0] },
            s: { a: 0, k: [100, 100] },
            r: { a: 0, k: 0 },
            o: { a: 0, k: 100 },
          },
        ],
      }],
    }],
  };
}

describe("FR-611 deterministic Lottie subset renderer", () => {
  it("renders only from an explicit frame and produces byte-identical pixels across runs", () => {
    const api = render as unknown as LottieExports;
    expect(api.createLottieAnimation).toBeTypeOf("function");
    expect(api.renderLottiePng).toBeTypeOf("function");
    if (api.createLottieAnimation === undefined || api.renderLottiePng === undefined) return;
    const animation = api.createLottieAnimation(animationFixture());
    const options = {
      frame: 17,
      width: 480,
      height: 280,
      colorSlots: {
        accent: "#FFE45E",
        outline: "#FF6B57",
        surface: "#102A43",
      },
    };

    const first = api.renderLottiePng(animation, options);
    const second = api.renderLottiePng(animation, options);
    const nextFrame = api.renderLottiePng(animation, { ...options, frame: 18 });

    expect(second).toEqual(first);
    expect(digest(nextFrame)).not.toBe(digest(first));
  });

  it("remaps named colors without changing geometry and pins shim changes into its hash", () => {
    const api = render as unknown as LottieExports;
    if (
      api.createLottieAnimation === undefined ||
      api.renderLottiePng === undefined ||
      api.lottieToolchainHash === undefined ||
      api.graphicOverlayToolchain === undefined
    ) return;
    const animation = api.createLottieAnimation(animationFixture());
    const base = api.renderLottiePng(animation, {
      frame: 17,
      width: 480,
      height: 280,
    });
    const branded = api.renderLottiePng(animation, {
      frame: 17,
      width: 480,
      height: 280,
      colorSlots: {
        accent: "#7C3AED",
        outline: "#F8FAFC",
        surface: "#111827",
      },
    });

    expect(branded).not.toEqual(base);
    expect(api.lottieToolchainHash()).toMatch(/^[0-9a-f]{64}$/u);
    expect(api.lottieToolchainHash("lottie-canvas-shim/v2"))
      .not.toBe(api.lottieToolchainHash());
    expect(api.graphicOverlayToolchain("lottie-canvas-shim/v2").version)
      .not.toBe(api.graphicOverlayToolchain().version);
    expect(api.graphicOverlayToolchain().version)
      .toContain(api.lottieToolchainHash());
  });

  it("does not allow callers to bypass the feature gate with supplied metadata", () => {
    const api = render as unknown as LottieExports;
    if (api.createLottieAnimation === undefined) return;
    const document = animationFixture();
    document["layers"] = [{
      ty: 5,
      nm: "Forbidden text",
      ip: 0,
      op: 40,
      ks: {},
      t: {},
    }];

    expect(() => api.createLottieAnimation!(
      document,
      new Map(),
      {
        schema: "guyditor/lottie-feature-profile/v1",
        renderer: "guyditor-lottie-subset/v1",
        lottieVersion: "5.12.2",
        width: 240,
        height: 140,
        frameRate: 30,
        inPoint: 0,
        outPoint: 40,
        features: [],
        colorSlots: [],
      },
    )).toThrow(/text layer at layers\[0\] "Forbidden text"/u);
  });
});
