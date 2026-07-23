import { describe, expect, it } from "vitest";

import * as core from "../index.js";

interface LottieFeatureProfile {
  schema: "guyditor/lottie-feature-profile/v1";
  renderer: string;
  lottieVersion: string;
  width: number;
  height: number;
  frameRate: number;
  inPoint: number;
  outPoint: number;
  features: string[];
  colorSlots: string[];
}

interface LottieUnsupportedFeature {
  feature: string;
  layerPath: string;
}

type LottieAnalysis =
  | { ok: true; profile: LottieFeatureProfile }
  | { ok: false; unsupported: LottieUnsupportedFeature[] };

interface LottieExports {
  analyzeLottieDocument?: (
    document: unknown,
    options?: {
      documentPath?: string;
      registeredRasterPaths?: readonly string[];
    },
  ) => LottieAnalysis;
}

function minimalLottie(): Record<string, unknown> {
  return {
    v: "5.12.2",
    fr: 30,
    ip: 0,
    op: 60,
    w: 200,
    h: 100,
    assets: [],
    layers: [{
      ty: 4,
      nm: "Badge",
      ip: 0,
      op: 60,
      ks: {
        a: { a: 0, k: [0, 0] },
        p: { a: 0, k: [100, 50] },
        s: { a: 0, k: [100, 100] },
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
      },
      shapes: [{
        ty: "gr",
        nm: "Card",
        it: [
          {
            ty: "rc",
            nm: "Card rectangle",
            p: { a: 0, k: [0, 0] },
            s: { a: 0, k: [160, 64] },
            r: { a: 0, k: 12 },
          },
          {
            ty: "fl",
            nm: "surface",
            c: { a: 0, k: [0.1, 0.2, 0.3, 1] },
            o: { a: 0, k: 100 },
          },
          {
            ty: "st",
            nm: "accent",
            c: { a: 0, k: [0.4, 0.8, 0.7, 1] },
            o: { a: 0, k: 100 },
            w: { a: 0, k: 3 },
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

describe("FR-611 Lottie static feature gate", () => {
  it("accepts the bounded shape subset and records a stable feature profile", () => {
    const api = core as unknown as LottieExports;
    expect(api.analyzeLottieDocument).toBeTypeOf("function");
    if (api.analyzeLottieDocument === undefined) return;

    const result = api.analyzeLottieDocument(minimalLottie());

    expect(result).toEqual({
      ok: true,
      profile: {
        schema: "guyditor/lottie-feature-profile/v1",
        renderer: "guyditor-lottie-subset/v1",
        lottieVersion: "5.12.2",
        width: 200,
        height: 100,
        frameRate: 30,
        inPoint: 0,
        outPoint: 60,
        features: [
          "fill",
          "group",
          "rectangle",
          "shape-layer",
          "stroke",
          "transform",
        ],
        colorSlots: ["accent", "surface"],
      },
    });
  });

  it("returns every expression and text layer with a named layer path", () => {
    const api = core as unknown as LottieExports;
    if (api.analyzeLottieDocument === undefined) return;
    const document = minimalLottie();
    const layers = document["layers"] as Array<Record<string, unknown>>;
    const first = layers[0]!;
    first["ks"] = {
      ...(first["ks"] as Record<string, unknown>),
      r: { a: 0, k: 0, x: "time * 30" },
    };
    layers.push({
      ty: 5,
      nm: "Headline",
      ip: 0,
      op: 60,
      ks: first["ks"],
      t: {},
    });

    expect(api.analyzeLottieDocument(document)).toEqual({
      ok: false,
      unsupported: [
        { feature: "expression", layerPath: "layers[0] \"Badge\"" },
        { feature: "expression", layerPath: "layers[1] \"Headline\"" },
        { feature: "text layer", layerPath: "layers[1] \"Headline\"" },
      ],
    });
  });

  it("rejects unregistered raster assets and accepts an exact hash-registered path", () => {
    const api = core as unknown as LottieExports;
    if (api.analyzeLottieDocument === undefined) return;
    const document = minimalLottie();
    document["assets"] = [{
      id: "image_0",
      w: 32,
      h: 32,
      u: "images/",
      p: "dot.png",
      e: 0,
    }];
    (document["layers"] as unknown[]).push({
      ty: 2,
      nm: "Dot image",
      refId: "image_0",
      ip: 0,
      op: 60,
      ks: {
        a: { a: 0, k: [0, 0] },
        p: { a: 0, k: [0, 0] },
        s: { a: 0, k: [100, 100] },
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
      },
    });

    expect(api.analyzeLottieDocument(document, {
      documentPath: "animations/card.json",
      registeredRasterPaths: [],
    })).toEqual({
      ok: false,
      unsupported: [{
        feature: "unregistered raster",
        layerPath: "layers[1] \"Dot image\"",
      }],
    });

    const registered = api.analyzeLottieDocument(document, {
      documentPath: "animations/card.json",
      registeredRasterPaths: ["animations/images/dot.png"],
    });
    expect(registered.ok).toBe(true);
    if (registered.ok) {
      expect(registered.profile.features).toContain("registered-raster");
      expect(registered.profile.features).toContain("image-layer");
    }
  });

  it("rejects bounded-subset combinations that the painter would otherwise drop", () => {
    const api = core as unknown as LottieExports;
    if (api.analyzeLottieDocument === undefined) return;
    const document = minimalLottie();
    const layer = (document["layers"] as Array<Record<string, unknown>>)[0]!;
    const group = (layer["shapes"] as Array<Record<string, unknown>>)[0]!;
    (group["it"] as unknown[]).splice(3, 0, {
      ty: "tm",
      nm: "Trimmed fill",
      s: { a: 0, k: 0 },
      e: { a: 0, k: 50 },
      o: { a: 0, k: 0 },
      m: 1,
    });

    expect(api.analyzeLottieDocument(document)).toEqual({
      ok: false,
      unsupported: [{
        feature: "trim path with fill",
        layerPath: "layers[0] \"Badge\"",
      }],
    });
  });

  it("names network-backed raster features independently of registration", () => {
    const api = core as unknown as LottieExports;
    if (api.analyzeLottieDocument === undefined) return;
    const document = minimalLottie();
    document["assets"] = [{
      id: "image_0",
      w: 32,
      h: 32,
      u: "https://cdn.example.invalid/",
      p: "dot.png",
      e: 0,
    }];
    (document["layers"] as unknown[]).push({
      ty: 2,
      nm: "Remote image",
      refId: "image_0",
      ip: 0,
      op: 60,
      ks: {
        a: { a: 0, k: [0, 0] },
        p: { a: 0, k: [0, 0] },
        s: { a: 0, k: [100, 100] },
        r: { a: 0, k: 0 },
        o: { a: 0, k: 100 },
      },
    });

    expect(api.analyzeLottieDocument(document)).toEqual({
      ok: false,
      unsupported: [{
        feature: "network asset",
        layerPath: "layers[1] \"Remote image\"",
      }],
    });
  });

  it("rejects animated Bezier paths whose topology changes between keyframes", () => {
    const api = core as unknown as LottieExports;
    if (api.analyzeLottieDocument === undefined) return;
    const document = minimalLottie();
    const layer = (document["layers"] as Array<Record<string, unknown>>)[0]!;
    layer["shapes"] = [{
      ty: "sh",
      nm: "Changing path",
      ks: {
        a: 1,
        k: [{
          t: 0,
          s: [{
            i: [[0, 0], [0, 0], [0, 0]],
            o: [[0, 0], [0, 0], [0, 0]],
            v: [[0, 0], [20, 0], [10, 20]],
            c: true,
          }],
          e: [{
            i: [[0, 0], [0, 0], [0, 0], [0, 0]],
            o: [[0, 0], [0, 0], [0, 0], [0, 0]],
            v: [[0, 0], [20, 0], [20, 20], [0, 20]],
            c: true,
          }],
        }, {
          t: 30,
          s: [{
            i: [[0, 0], [0, 0], [0, 0], [0, 0]],
            o: [[0, 0], [0, 0], [0, 0], [0, 0]],
            v: [[0, 0], [20, 0], [20, 20], [0, 20]],
            c: true,
          }],
        }],
      },
    }];

    expect(api.analyzeLottieDocument(document)).toEqual({
      ok: false,
      unsupported: [{
        feature: "changing path topology",
        layerPath: "layers[0] \"Badge\"",
      }],
    });
  });
});
