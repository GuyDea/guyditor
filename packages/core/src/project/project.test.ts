import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ID_PATTERNS,
  ID_PREFIXES,
  REVISION_ID_PATTERN,
  WORD_ID_PATTERN,
  canonicalizeYaml,
  formatRevision,
  formatWordId,
  makeId,
  parseProjectYaml,
  parseRevision,
  parseWordId,
  validateProject,
} from "../index.js";
import type { GuyditorProject, Result } from "../index.js";

const HASH = "a".repeat(64);

function valueOf<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function projectFixture(): GuyditorProject {
  return {
    format: "guyditor/v1",
    revision: "rev_00001",
    project: {
      id: "prj_aaaaaaaaaa",
      name: "Fixture",
      created: "2026-07-18T10:00:00Z",
    },
    settings: {
      timeline: { fps: "24/1", width: 1920, height: 1080 },
      audio: { sampleRate: 48_000, channels: 2 },
      primaryDeliverable: "dlv_aaaaaaaaaa",
    },
    transcript: { nextWordOrdinal: 1 },
    assets: [
      {
        id: "ast_aaaaaaaaaa",
        kind: "video",
        path: "media/a.mov",
        sha256: HASH,
        probe: { fps: "24/1" },
      },
    ],
    beats: [],
    sequences: [
      {
        id: "seq_aaaaaaaaaa",
        name: "main",
        clips: [
          {
            id: "clp_aaaaaaaaaa",
            asset: "ast_aaaaaaaaaa",
            source: {
              in: { frames: 0, fps: "24/1" },
              out: { frames: 24, fps: "24/1" },
            },
          },
          {
            id: "clp_bbbbbbbbbb",
            asset: "ast_aaaaaaaaaa",
            source: {
              in: { frames: 24, fps: "24/1" },
              out: { frames: 48, fps: "24/1" },
            },
          },
        ],
      },
    ],
    layers: [
      {
        id: "lyr_aaaaaaaaaa",
        kind: "video",
        name: "main",
        order: 0,
        enabled: true,
        locked: false,
        sequence: "seq_aaaaaaaaaa",
      },
    ],
    captions: [
      {
        id: "cts_aaaaaaaaaa",
        name: "captions",
        sourceLayerIds: ["lyr_aaaaaaaaaa"],
        preset: { presetId: "pre_aaaaaaaaaa", version: 1 },
        styleOverrides: {},
        breakOverrides: [],
        emphasisOverrides: [],
        timingOffsets: [],
        enabled: true,
      },
    ],
    annotations: {
      sidecar: "annotations",
      summary: { open: 0, resolved: 0, rejected: 0, reopened: 0 },
    },
    deliverables: [
      {
        id: "dlv_aaaaaaaaaa",
        kind: "longform",
        name: "master",
        profile: "youtube@1.0.0",
        sequenceId: "seq_aaaaaaaaaa",
        captionsTrackId: "cts_aaaaaaaaaa",
        status: "draft",
      },
    ],
    presets: [
      {
        id: "pre_aaaaaaaaaa",
        name: "captions",
        kind: "caption",
        version: 1,
        path: "presets/pre_aaaaaaaaaa@1.yaml",
        sha256: HASH,
      },
    ],
    skills: [
      {
        id: "skl_aaaaaaaaaa",
        name: "editing",
        version: "1.0.0",
        path: "skills/editing/1.0.0/",
        contentHash: HASH,
      },
    ],
    sidecars: [
      {
        name: "annotations",
        path: "sidecars/annotations.yaml",
        schema: "guyditor.annotations/v1",
        sha256: HASH,
        inputs: [{ asset: "ast_aaaaaaaaaa", sha256: HASH }],
      },
    ],
  };
}

function expectInvariant(
  project: GuyditorProject,
  invariant: string,
  affected: readonly string[],
): void {
  const result = validateProject(project);
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "E_PROJECT_INVARIANT",
      acceptedStateChanged: false,
      retry: "none",
      affected: [...affected],
    },
  });
  if (!result.ok) expect(result.error.message).toContain(invariant);
}

describe("project IDs", () => {
  it("generates every registered prefix with ten lowercase base32 characters", () => {
    expect(ID_PREFIXES).toContain("prj");
    expect(ID_PREFIXES).toContain("fx");
    expect(ID_PREFIXES).toContain("gfx");
    expect(ID_PREFIXES).toContain("txn");
    expect(ID_PREFIXES).toContain("prp");
    expect(ID_PREFIXES).toEqual(expect.arrayContaining(["asm", "crt", "tkc"]));

    for (const prefix of ID_PREFIXES) {
      const id = makeId(prefix);
      expect(id).toMatch(ID_PATTERNS[prefix]);
    }
  });

  it("formats and parses word and revision ordinals", () => {
    expect(formatWordId(42)).toBe("w000042");
    expect(parseWordId("w000042")).toBe(42);
    expect(formatRevision(17)).toBe("rev_00017");
    expect(parseRevision("rev_00017")).toBe(17);
    expect("w000042").toMatch(WORD_ID_PATTERN);
    expect("rev_00017").toMatch(REVISION_ID_PATTERN);
  });

  it("rejects out-of-range and malformed ordinals", () => {
    expect(() => formatWordId(1_000_000)).toThrow(RangeError);
    expect(() => formatRevision(-1)).toThrow(RangeError);
    expect(() => parseWordId("w" + "42")).toThrow(RangeError);
    expect(() => parseRevision("rev" + "_17")).toThrow(RangeError);
  });
});

describe("project validation", () => {
  it("accepts the complete closed model", () => {
    expect(valueOf(validateProject(projectFixture()))).toEqual(projectFixture());
  });

  it("accepts ISO-8601 asset timestamps with an explicit offset", () => {
    const project = projectFixture();
    project.assets[0]!.captureTime = {
      value: "2026-07-18T12:00:00+02:00",
      source: "container",
    };

    expect(valueOf(validateProject(project))).toEqual(project);
    expect(canonicalizeYaml(project)).toContain(
      'value: "2026-07-18T12:00:00+02:00"',
    );
  });

  it("reports Ajv shape errors in the Guyditor envelope", () => {
    const invalid: unknown = { ...projectFixture(), extra: true };
    const result = validateProject(invalid);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "E_SCHEMA_INVALID",
        affected: [],
        acceptedStateChanged: false,
        retry: "none",
      },
    });
    if (!result.ok) expect(result.error.message).toContain("additionalProperties");
  });

  it("requires all model references to resolve", () => {
    const project = projectFixture();
    project.sequences[0]!.clips[0]!.asset = "ast_bbbbbbbbbb";
    expectInvariant(project, "clip asset reference", ["clp_aaaaaaaaaa", "ast_bbbbbbbbbb"]);
  });

  it("requires caption preset references to resolve to the pinned version", () => {
    const project = projectFixture();
    project.captions[0]!.preset.presetId = "pre_bbbbbbbbbb";
    expectInvariant(project, "caption preset reference", ["cts_aaaaaaaaaa", "pre_bbbbbbbbbb"]);
  });

  it.each([
    {
      name: "settings primary deliverable",
      invariant: "settings.primaryDeliverable reference",
      affected: ["prj_aaaaaaaaaa", "dlv_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.settings.primaryDeliverable = "dlv_bbbbbbbbbb";
      },
    },
    {
      name: "layer sequence",
      invariant: "layer sequence reference",
      affected: ["lyr_aaaaaaaaaa", "seq_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.layers[0]!.sequence = "seq_bbbbbbbbbb";
      },
    },
    {
      name: "placed item sequence",
      invariant: "placed item sequence reference",
      affected: ["gfx_aaaaaaaaaa", "seq_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.layers.push({
          id: "lyr_bbbbbbbbbb",
          kind: "animation",
          name: "graphics",
          order: 1,
          enabled: true,
          locked: false,
          items: [{
            id: "gfx_aaaaaaaaaa",
            sequenceId: "seq_bbbbbbbbbb",
            template: "tpl_callout_text",
            at: "word:w000001",
            duration: { frames: 12, fps: "24/1" },
          }],
        });
      },
    },
    {
      name: "deliverable sequence",
      invariant: "deliverable sequence reference",
      affected: ["dlv_aaaaaaaaaa", "seq_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.deliverables[0]!.sequenceId = "seq_bbbbbbbbbb";
      },
    },
    {
      name: "matte layer",
      invariant: "matte layer reference",
      affected: ["lyr_aaaaaaaaaa", "lyr_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.layers[0]!.matte = {
          layerId: "lyr_bbbbbbbbbb",
          source: "alpha",
        };
      },
    },
    {
      name: "caption source layer",
      invariant: "caption sourceLayerIds reference",
      affected: ["cts_aaaaaaaaaa", "lyr_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.captions[0]!.sourceLayerIds = ["lyr_bbbbbbbbbb"];
      },
    },
    {
      name: "transition preset pin",
      invariant: "transition preset reference",
      affected: ["trn_aaaaaaaaaa", "pre_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.sequences[0]!.clips[0]!.transitionAfter = {
          id: "trn_aaaaaaaaaa",
          preset: "pre_bbbbbbbbbb",
          duration: { frames: 1, fps: "24/1" },
        };
      },
    },
    {
      name: "skill pin",
      invariant: "sidecar skill reference",
      affected: ["annotations", "skl_bbbbbbbbbb"],
      mutate(project: GuyditorProject): void {
        project.sidecars[0]!.generatedBy = {
          tool: "skl_bbbbbbbbbb",
          version: "1.0.0",
        };
      },
    },
  ])("requires the $name reference to resolve", ({ invariant, affected, mutate }) => {
    const project = projectFixture();
    mutate(project);
    expectInvariant(project, invariant, affected);
  });

  it("requires sidecar input references to resolve", () => {
    const project = projectFixture();
    project.sidecars[0]!.inputs = [{ sidecar: "missing", sha256: HASH }];
    expectInvariant(project, "sidecar input reference", ["annotations", "missing"]);
  });

  it("requires IDs to be globally unique", () => {
    const project = projectFixture();
    project.assets.push({ ...project.assets[0]! });
    expectInvariant(project, "globally unique IDs", ["ast_aaaaaaaaaa"]);
  });

  it("rejects placed-item ownership conflicts while keeping unqualified anchors orphanable", () => {
    const explicitConflict = projectFixture();
    explicitConflict.sequences.push({
      id: "seq_bbbbbbbbbb",
      name: "sibling",
      clips: [],
    });
    explicitConflict.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "animation",
      name: "graphics",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        id: "gfx_aaaaaaaaaa",
        sequenceId: "seq_aaaaaaaaaa",
        asset: "ast_aaaaaaaaaa",
        at: "timeline:seq_bbbbbbbbbb@2",
        duration: { frames: 12, fps: "24/1" },
      }],
    });
    expectInvariant(
      explicitConflict,
      "placed item sequence ownership consistency",
      ["gfx_aaaaaaaaaa", "seq_aaaaaaaaaa", "seq_bbbbbbbbbb"],
    );

    const inferredConflict = structuredClone(explicitConflict);
    delete inferredConflict.layers[1]!.items![0]!.sequenceId;
    inferredConflict.layers[1]!.items![0]!.at = "timeline:seq_aaaaaaaaaa@2";
    inferredConflict.layers[1]!.items![0]!.duration = {
      until: "timeline:seq_bbbbbbbbbb@8",
    };
    expectInvariant(
      inferredConflict,
      "placed item sequence ownership consistency",
      ["gfx_aaaaaaaaaa", "seq_aaaaaaaaaa", "seq_bbbbbbbbbb"],
    );

    const orphanable = structuredClone(explicitConflict);
    orphanable.layers[1]!.items![0]!.at = "ann:ann_bbbbbbbbbb";
    orphanable.layers[1]!.items![0]!.duration = { until: "word:w999999" };
    expect(valueOf(validateProject(orphanable))).toEqual(orphanable);
  });

  it("requires source ranges to use one rate and increase", () => {
    const rateMismatch = projectFixture();
    rateMismatch.sequences[0]!.clips[0]!.source.out.fps = "25/1";
    expectInvariant(rateMismatch, "source range matching rates", ["clp_aaaaaaaaaa"]);

    const reversed = projectFixture();
    reversed.sequences[0]!.clips[0]!.source.out.frames = 0;
    expectInvariant(reversed, "source.in < source.out", ["clp_aaaaaaaaaa"]);
  });

  it("rejects invalid overlap and gap boundary combinations", () => {
    const firstOverlap = projectFixture();
    firstOverlap.sequences[0]!.clips[0]!.overlapPrevious = { frames: 1, fps: "24/1" };
    expectInvariant(firstOverlap, "first clip overlapPrevious", ["clp_aaaaaaaaaa"]);

    const incomingTransition = projectFixture();
    incomingTransition.sequences[0]!.clips[0]!.transitionAfter = {
      id: "trn_aaaaaaaaaa",
      preset: "cut",
      duration: { frames: 1, fps: "24/1" },
    };
    incomingTransition.sequences[0]!.clips[1]!.overlapPrevious = { frames: 1, fps: "24/1" };
    expectInvariant(incomingTransition, "incoming transition and overlapPrevious", ["clp_aaaaaaaaaa", "clp_bbbbbbbbbb"]);

    const gapAndOverlap = projectFixture();
    gapAndOverlap.sequences[0]!.clips[1]!.gapBefore = { frames: 1, fps: "24/1" };
    gapAndOverlap.sequences[0]!.clips[1]!.overlapPrevious = { frames: 1, fps: "24/1" };
    expectInvariant(gapAndOverlap, "gapBefore boundary exclusivity", ["clp_bbbbbbbbbb"]);
  });

  it("requires generated provenance and the annotations sidecar", () => {
    const generated = projectFixture();
    generated.assets[0]!.kind = "generated";
    expectInvariant(generated, "generated asset provenance", ["ast_aaaaaaaaaa"]);

    const annotations = projectFixture();
    annotations.annotations.sidecar = "missing";
    expectInvariant(annotations, "annotations.sidecar reference", ["missing"]);
  });
});

describe("canonical project YAML", () => {
  it("parses, validates, canonicalizes, and re-parses the annotated example", async () => {
    const text = await readFile(
      new URL("./__fixtures__/example.guyditor.yaml", import.meta.url),
      "utf8",
    );
    const parsed = valueOf(parseProjectYaml(text));
    const canonical = canonicalizeYaml(parsed);

    expect(canonical).not.toContain("# ----");
    expect(canonical).toContain('created: "2026-07-12T09:14:03Z"');
    expect(canonical).toContain("duration: { frames: 41890, fps: 30000/1001 }");
    expect(canonical.endsWith("\n")).toBe(true);
    expect(canonical.endsWith("\n\n")).toBe(false);
    const reparsed = valueOf(parseProjectYaml(canonical));
    const expected = structuredClone(parsed);
    expected.assets.sort((left, right) => left.id.localeCompare(right.id));
    expected.beats.sort((left, right) => left.id.localeCompare(right.id));
    expected.captions.sort((left, right) => left.id.localeCompare(right.id));
    expected.deliverables.sort((left, right) => left.id.localeCompare(right.id));
    expected.presets.sort((left, right) => left.id.localeCompare(right.id));
    expected.skills.sort((left, right) => left.id.localeCompare(right.id));
    expected.sidecars.sort((left, right) => left.name.localeCompare(right.name));
    expect(reparsed).toEqual(expected);
  });

  it("uses declaration key order, registry sorting, semantic list order, and safe scalars", () => {
    const project = projectFixture();
    project.project.name = "true";
    project.assets.unshift({
      id: "ast_bbbbbbbbbb",
      kind: "image",
      path: "media/b.png",
      sha256: "b".repeat(64),
      probe: {},
    });
    project.sequences[0]!.clips.reverse();

    const canonical = canonicalizeYaml(project);
    expect(canonical.indexOf("ast_aaaaaaaaaa")).toBeLessThan(canonical.indexOf("ast_bbbbbbbbbb"));
    expect(canonical.indexOf("clp_bbbbbbbbbb")).toBeLessThan(canonical.indexOf("clp_aaaaaaaaaa"));
    expect(canonical).toContain('name: "true"');
    expect(canonical).toBe(canonical.normalize("NFC"));
    expect(canonical).not.toContain("\r");
  });

  it("orders nested clip audio and safely emits arbitrary record keys", () => {
    const project = projectFixture();
    project.sequences[0]!.clips[0]!.audio = {
      gainDb: -1,
      fadeIn: { frames: 2, fps: "24/1" },
      mute: false,
    };
    project.sequences[0]!.clips[0]!.effects = [
      {
        id: "fx_aaaaaaaaaa",
        kind: "metadata",
        params: { "a: b": "true" },
      },
    ];

    const canonical = canonicalizeYaml(project);
    expect(canonical).toContain(
      "audio: { gainDb: -1, fadeIn: { frames: 2, fps: 24/1 }, mute: false }",
    );
    expect(canonical).toContain('"a: b": "true"');
    expect(valueOf(parseProjectYaml(canonical))).toEqual(project);
  });

  it("orders placed-item sequence ownership immediately after its id and round-trips it", () => {
    const project = projectFixture();
    project.layers.push({
      id: "lyr_bbbbbbbbbb",
      kind: "image",
      name: "owned overlay",
      order: 1,
      enabled: true,
      locked: false,
      items: [{
        duration: { frames: 12, fps: "24/1" },
        at: "word:w000001",
        asset: "ast_aaaaaaaaaa",
        sequenceId: "seq_aaaaaaaaaa",
        id: "gfx_aaaaaaaaaa",
      }],
    });

    const canonical = canonicalizeYaml(project);
    expect(canonical).toContain(
      "      -\n        id: gfx_aaaaaaaaaa\n        sequenceId: seq_aaaaaaaaaa\n        asset: ast_aaaaaaaaaa",
    );
    expect(valueOf(parseProjectYaml(canonical))).toEqual(project);
  });

  it("uses literal multiline scalars and never wraps long scalar lines", () => {
    const project = projectFixture();
    const longName = "x".repeat(180);
    project.project.name = longName;
    project.assets[0]!.rights = {
      origin: "captured",
      licenseName: "owned",
      restrictions: ["first line", "second line"],
    };

    const canonical = canonicalizeYaml(project);
    expect(canonical).toContain(`name: ${longName}\n`);
    expect(canonical).toContain(
      "restrictions:\n        - first line\n        - second line",
    );
    expect(valueOf(parseProjectYaml(canonical))).toEqual(project);
  });

  it("returns schema errors for malformed YAML without throwing", () => {
    expect(parseProjectYaml("format: [\n")).toMatchObject({
      ok: false,
      error: { code: "E_SCHEMA_INVALID" },
    });
  });
});
