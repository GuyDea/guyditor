import { useEffect, useMemo, useRef, useState } from "react";

import {
  constraintsFromDrag,
  solvePlacement,
} from "../../../compositor/src/placement.js";
import {
  compilePipTimeline,
  compileMotionTransition,
  evaluatePipAtFrame,
  motionPreset,
} from "../../../compositor/src/motion.js";
import { overlapWarningForRect } from "../../../compositor/src/avoidance.js";
import type {
  AvoidRegion,
  PipConfig,
  PlacementConstraints,
} from "../../../core/src/index.js";

interface PipPreviewCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  pip: PipConfig;
  avoidRegions: readonly AvoidRegion[];
  frame: number;
  composition: { width: number; height: number };
  onPlace: (placement: PlacementConstraints) => Promise<void>;
  anchorFrames?: Readonly<Record<string, number>>;
}

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_uv = a_uv; }
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_video;
uniform float u_shape;
uniform float u_radius;
uniform float u_border;
uniform float u_opacity;
uniform vec4 u_border_color;
varying vec2 v_uv;
float shape_alpha(vec2 uv) {
  vec2 p = abs(uv - 0.5);
  if (u_shape < 0.5) return 1.0;
  if (u_shape < 1.5) return step(length((uv - 0.5) * 2.0), 1.0);
  if (u_shape < 2.5) return step(length(vec2((uv.x - 0.5) * 2.0, (uv.y - 0.5) * 2.0)), 1.0);
  vec2 q = max(p - vec2(0.5 - u_radius), 0.0);
  return step(length(q), u_radius);
}
void main() {
  float alpha = shape_alpha(v_uv);
  vec4 source = texture2D(u_video, v_uv);
  float edge = min(min(v_uv.x, 1.0-v_uv.x), min(v_uv.y, 1.0-v_uv.y));
  float border = step(edge, u_border) * alpha;
  gl_FragColor = mix(source * alpha, u_border_color, border);
  gl_FragColor.a *= alpha * u_opacity;
}
`;

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("WebGL shader allocation failed.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL shader compilation failed.");
  }
  return shader;
}

function maskCode(shape: PipConfig["style"]["mask"]["shape"]): number {
  if (shape === "circle") return 1;
  if (shape === "ellipse") return 2;
  if (shape === "rounded") return 3;
  return 0;
}

export function PipPreviewCanvas({
  videoRef,
  pip,
  avoidRegions,
  frame,
  composition,
  onPlace,
  anchorFrames = {},
}: PipPreviewCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const initialSample = useMemo(() => {
    if (pip.keyframes.every(({ at }) => Number.isSafeInteger(anchorFrames[at]))) {
      return evaluatePipAtFrame(compilePipTimeline({
        pip,
        compWidth: composition.width,
        compHeight: composition.height,
        anchorFrames,
      }), frame);
    }
    return {
      atOutputFrame: frame,
      rect: solvePlacement(pip.placement.base, composition.width, composition.height),
      opacity: 1,
      source: "base",
    };
  }, [anchorFrames, composition.height, composition.width, frame, pip]);
  const initial = initialSample.rect;
  const [rect, setRect] = useState(initial);
  const [opacity, setOpacity] = useState(initialSample.opacity);
  const drag = useRef<{ x: number; y: number; rect: typeof initial } | null>(null);
  const overlap = overlapWarningForRect(rect, avoidRegions, frame);

  useEffect(() => {
    setRect(initial);
    setOpacity(initialSample.opacity);
  }, [initial, initialSample.opacity]);

  useEffect(() => {
    let animation = 0;
    const preview = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      const preset = motionPreset(event.detail);
      const samples = compileMotionTransition({
        preset,
        from: {
          rect: { ...initial, x: Math.max(-initial.w, initial.x - 0.18) },
          opacity: 0.35,
        },
        to: { rect: initial, opacity: 1 },
        startFrame: 0,
        endFrame: preset.defaultDurationFrames,
        sampleEveryFrames: 1,
      });
      const started = performance.now();
      cancelAnimationFrame(animation);
      const tick = (now: number): void => {
        const previewFrame = Math.min(
          preset.defaultDurationFrames,
          Math.round((now - started) * 30 / 1_000),
        );
        const previewSample = evaluatePipAtFrame({ samples }, previewFrame);
        setRect(previewSample.rect);
        setOpacity(previewSample.opacity);
        if (previewFrame < preset.defaultDurationFrames) animation = requestAnimationFrame(tick);
        else {
          setRect(initial);
          setOpacity(initialSample.opacity);
        }
      };
      animation = requestAnimationFrame(tick);
    };
    window.addEventListener("guyditor:pip-preset-preview", preview);
    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener("guyditor:pip-preset-preview", preview);
    };
  }, [initial, initialSample.opacity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (gl === null) return;
    const program = gl.createProgram();
    if (program === null) return;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "a_position");
    const uv = gl.getAttribLocation(program, "a_uv");
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (buffer === null || texture === null) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    let request = 0;
    const render = (): void => {
      const x0 = rect.x * 2 - 1;
      const x1 = (rect.x + rect.w) * 2 - 1;
      const y0 = 1 - rect.y * 2;
      const y1 = 1 - (rect.y + rect.h) * 2;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        x0, y1, 0, 0, x1, y1, 1, 0, x0, y0, 0, 1,
        x0, y0, 0, 1, x1, y1, 1, 0, x1, y0, 1, 1,
      ]), gl.DYNAMIC_DRAW);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const video = videoRef.current;
      if (video !== null && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([26, 34, 39, 255]));
      }
      gl.uniform1f(gl.getUniformLocation(program, "u_shape"), maskCode(pip.style.mask.shape));
      gl.uniform1f(gl.getUniformLocation(program, "u_radius"), pip.style.mask.cornerRadius ?? 0.08);
      gl.uniform1f(gl.getUniformLocation(program, "u_border"),
        (pip.style.border?.widthPx ?? 0) / Math.max(1, rect.w * composition.width));
      gl.uniform1f(gl.getUniformLocation(program, "u_opacity"), opacity);
      const severityColor = overlap.severity === "hard"
        ? [0.94, 0.28, 0.26, 1]
        : overlap.severity === "soft" ? [0.95, 0.67, 0.24, 1] : [1, 1, 1, pip.style.border?.opacity ?? 0];
      gl.uniform4fv(gl.getUniformLocation(program, "u_border_color"), severityColor);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      request = requestAnimationFrame(render);
    };
    render();
    return () => {
      cancelAnimationFrame(request);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteProgram(program);
    };
  }, [composition.width, opacity, overlap.severity, pip.style, rect, videoRef]);

  return (
    <>
      <canvas
        ref={canvasRef}
        width={composition.width}
        height={composition.height}
        className="pip-preview-canvas"
        data-testid="pip-preview-canvas"
        data-overlap={overlap.severity}
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const point = {
            x: (event.clientX - bounds.left) / bounds.width,
            y: (event.clientY - bounds.top) / bounds.height,
          };
          if (point.x < rect.x || point.x > rect.x + rect.w || point.y < rect.y || point.y > rect.y + rect.h) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { ...point, rect };
        }}
        onPointerMove={(event) => {
          if (drag.current === null) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const x = (event.clientX - bounds.left) / bounds.width;
          const y = (event.clientY - bounds.top) / bounds.height;
          setRect({
            ...drag.current.rect,
            x: Math.max(-drag.current.rect.w / 2, Math.min(1 - drag.current.rect.w / 2, drag.current.rect.x + x - drag.current.x)),
            y: Math.max(-drag.current.rect.h / 2, Math.min(1 - drag.current.rect.h / 2, drag.current.rect.y + y - drag.current.y)),
          });
        }}
        onPointerUp={(event) => {
          if (drag.current === null) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          void onPlace(constraintsFromDrag(
            rect,
            composition.width,
            composition.height,
            pip.placement.base,
          ));
        }}
      />
      {avoidRegions.filter((region) => region.frames === undefined ||
        (frame >= region.frames.from && frame <= region.frames.to)).map((region) => (
        <span
          key={region.id}
          className="pip-avoid-region"
          data-hardness={region.hardness}
          title={`${region.source} · ${region.hardness}`}
          style={{
            left: `${String(region.rect.x * 100)}%`, top: `${String(region.rect.y * 100)}%`,
            width: `${String(region.rect.w * 100)}%`, height: `${String(region.rect.h * 100)}%`,
          }}
        />
      ))}
    </>
  );
}
