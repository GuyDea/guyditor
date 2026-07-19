import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import * as render from "./index.js";

const TEMPLATE_ID = "tpl_a2c3d4e5f6";

interface RegistryExports {
  validateTemplatePackage?: (path: string) => Promise<{
    ok: boolean;
    value?: { manifest: { id: string; version: string }; contentHash: string };
    error?: { code: string; message: string };
  }>;
  TemplateRegistry?: new (options: {
    builtinsRoot: string;
    userRoot: string;
    projectRoot?: string;
    compiledRoot?: string;
  }) => {
    latest(id: string): Promise<{ ok: boolean; value?: { version: string; contentHash: string } }>;
    get(id: string, version: string): Promise<{
      ok: boolean;
      value?: { version: string; contentHash: string };
    }>;
  };
}

async function packageFixture(
  manifestPatch = "",
  renderSource = "export default { render(ctx) { ctx.canvas.fillRect(0, 0, 1, 1); } };\n",
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guyditor-template-package-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "fonts"));
  const canvas = createCanvas(640, 360);
  await writeFile(join(root, "preview.png"), canvas.toBuffer("image/png"));
  await writeFile(join(root, "render.ts"), renderSource, "utf8");
  await writeFile(join(root, "template.yaml"), `schema: guyditor/template/v1
id: ${TEMPLATE_ID}
name: Registry fixture
kind: lower_third
version: 1.0.0
engine: overlay/v1
entry: render.ts
min_guyditor: "1.0.0"
duration:
  mode: fixed
  default: { frames: 90, fps: "30/1" }
params:
  type: object
  additionalProperties: false
  required: [title]
  properties:
    title: { type: string, maxLength: 60 }
preview:
  file: preview.png
  params: { title: Fixture }
fonts: []
safe_area_aware: true
${manifestPatch}`, "utf8");
  return root;
}

async function rewriteManifest(
  root: string,
  replacements: Readonly<Record<string, string>>,
): Promise<void> {
  let manifest = await readFile(join(root, "template.yaml"), "utf8");
  for (const [from, to] of Object.entries(replacements)) manifest = manifest.replace(from, to);
  await writeFile(join(root, "template.yaml"), manifest, "utf8");
}

describe("FR-600 template package validation", () => {
  it("loads a closed v1 package and computes a stable canonical content hash", async () => {
    const validate = (render as unknown as RegistryExports).validateTemplatePackage;
    expect(validate).toBeTypeOf("function");
    if (validate === undefined) return;
    const root = await packageFixture();

    const first = await validate(root);
    const second = await validate(root);

    expect(first.ok).toBe(true);
    expect(first.value).toMatchObject({
      manifest: { id: TEMPLATE_ID, version: "1.0.0" },
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(second).toEqual(first);
  });

  it("resolves latest semver while project-local content wins for the same id and version", async () => {
    const Registry = (render as unknown as RegistryExports).TemplateRegistry;
    expect(Registry).toBeTypeOf("function");
    if (Registry === undefined) return;
    const root = await mkdtemp(join(tmpdir(), "guyditor-template-libraries-"));
    const builtinsRoot = join(root, "builtins");
    const userRoot = join(root, "user");
    const projectRoot = join(root, "project");
    await Promise.all([mkdir(builtinsRoot), mkdir(userRoot), mkdir(projectRoot)]);

    const builtin = await packageFixture();
    const user = await packageFixture();
    const project = await packageFixture();
    await rewriteManifest(user, { "version: 1.0.0": "version: 2.0.0" });
    await rewriteManifest(project, { "version: 1.0.0": "version: 2.0.0" });
    await writeFile(join(project, "render.ts"), "export default { render(ctx) { ctx.canvas.fillRect(0, 0, 2, 2); } };\n");
    await mkdir(join(builtinsRoot, "lower-third"));
    await mkdir(join(userRoot, TEMPLATE_ID, "2.0.0"), { recursive: true });
    await mkdir(join(projectRoot, TEMPLATE_ID, "2.0.0"), { recursive: true });
    const { cp } = await import("node:fs/promises");
    await Promise.all([
      cp(builtin, join(builtinsRoot, "lower-third"), { recursive: true }),
      cp(user, join(userRoot, TEMPLATE_ID, "2.0.0"), { recursive: true }),
      cp(project, join(projectRoot, TEMPLATE_ID, "2.0.0"), { recursive: true }),
    ]);

    const registry = new Registry({ builtinsRoot, userRoot, projectRoot });
    const latest = await registry.latest(TEMPLATE_ID);
    const exact = await registry.get(TEMPLATE_ID, "2.0.0");
    const projectPackage = await (render as unknown as RegistryExports)
      .validateTemplatePackage!(join(projectRoot, TEMPLATE_ID, "2.0.0"));

    expect(latest.ok).toBe(true);
    expect(latest.value?.version).toBe("2.0.0");
    expect(exact.value?.contentHash).toBe(projectPackage.value?.contentHash);
  });

  it("rejects the closed package-validation matrix", async () => {
    const validate = (render as unknown as RegistryExports).validateTemplatePackage;
    expect(validate).toBeTypeOf("function");
    if (validate === undefined) return;
    const cases: Array<{
      name: string;
      mutate(root: string): Promise<void>;
    }> = [
      {
        name: "missing manifest",
        mutate: (root) => rm(join(root, "template.yaml")),
      },
      {
        name: "unknown manifest key",
        mutate: async (root) => writeFile(
          join(root, "template.yaml"),
          `${await readFile(join(root, "template.yaml"), "utf8")}unknown_key: true\n`,
        ),
      },
      {
        name: "invalid template id",
        mutate: (root) => rewriteManifest(root, { [TEMPLATE_ID]: ["tpl", "BAD"].join("_") }),
      },
      {
        name: "invalid semver",
        mutate: (root) => rewriteManifest(root, { "version: 1.0.0": "version: latest" }),
      },
      {
        name: "unsupported engine",
        mutate: (root) => rewriteManifest(root, { "engine: overlay/v1": "engine: web/v2" }),
      },
      {
        name: "missing fixed default",
        mutate: (root) => rewriteManifest(root, {
          "  default: { frames: 90, fps: \"30/1\" }\n": "",
        }),
      },
      {
        name: "path traversal",
        mutate: (root) => rewriteManifest(root, { "entry: render.ts": "entry: ../render.ts" }),
      },
      {
        name: "missing declared entry",
        mutate: (root) => rm(join(root, "render.ts")),
      },
      {
        name: "invalid parameter schema",
        mutate: (root) => rewriteManifest(root, {
          "title: { type: string, maxLength: 60 }": "title: { type: string, unknownKeyword: true }",
        }),
      },
      {
        name: "preview params rejected",
        mutate: (root) => rewriteManifest(root, { "params: { title: Fixture }": "params: { title: 42 }" }),
      },
      {
        name: "wrong preview geometry",
        mutate: async (root) => writeFile(
          join(root, "preview.png"),
          createCanvas(32, 18).toBuffer("image/png"),
        ),
      },
      {
        name: "entry compile error",
        mutate: (root) => writeFile(join(root, "render.ts"), "export default { render( };\n"),
      },
    ];

    for (const matrixCase of cases) {
      const root = await packageFixture();
      await matrixCase.mutate(root);
      const result = await validate(root);
      expect(result, matrixCase.name).toMatchObject({
        ok: false,
        error: { code: "E_TEMPLATE_PACKAGE_INVALID" },
      });
    }
  });
});
