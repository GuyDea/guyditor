import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import type { KeySettings } from "../../../core/src/index.js";

type Rgb = readonly [number, number, number];

function chroma([red, green, blue]: Rgb): readonly [number, number] {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return [0.5 + (blue - luma) / 1.8556, 0.5 + (red - luma) / 1.5748];
}

export function chromaPreviewAlpha(
  pixel: Rgb,
  keyColor: Rgb,
  tolerance: number,
  softness: number,
): number {
  const [cb, cr] = chroma(pixel);
  const [keyCb, keyCr] = chroma(keyColor);
  const distance = Math.hypot(cb - keyCb, cr - keyCr) / Math.SQRT2;
  const similarity = 0.01 + 0.39 * tolerance;
  const blendW = 0.4 * softness;
  if (distance < similarity) return 0;
  if (blendW === 0 || distance >= similarity + blendW) return 1;
  return (distance - similarity) / blendW;
}

function parseColor(value: string): Rgb {
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ];
}

function shader(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const compiled = gl.createShader(kind);
  if (compiled === null) throw new Error("WebGL could not allocate a chroma-preview shader.");
  gl.shaderSource(compiled, source);
  gl.compileShader(compiled);
  if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(compiled) ?? "WebGL chroma-preview shader compilation failed.");
  }
  return compiled;
}

const VERTEX_SHADER = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  uv = vec2((position.x + 1.0) * 0.5, 1.0 - (position.y + 1.0) * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D frameTexture;
uniform vec3 keyColor;
uniform float tolerance;
uniform float softness;
uniform float spillStrength;
uniform int dominantChannel;
in vec2 uv;
out vec4 outputColor;
vec2 bt709Chroma(vec3 rgb) {
  float y = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return vec2(0.5 + (rgb.b - y) / 1.8556, 0.5 + (rgb.r - y) / 1.5748);
}
void main() {
  vec3 rgb = texture(frameTexture, uv).rgb;
  float d = distance(bt709Chroma(rgb), bt709Chroma(keyColor)) / sqrt(2.0);
  float similarity = 0.01 + 0.39 * tolerance;
  float blendW = 0.4 * softness;
  float alpha = d < similarity ? 0.0 :
    (blendW == 0.0 || d >= similarity + blendW ? 1.0 : (d - similarity) / blendW);
  if (dominantChannel == 1) {
    float avg2 = (rgb.r + rgb.b) * 0.5;
    rgb.g = min(rgb.g, avg2 + (1.0 - spillStrength) * max(0.0, rgb.g - avg2));
  } else if (dominantChannel == 2) {
    float avg2 = (rgb.r + rgb.g) * 0.5;
    rgb.b = min(rgb.b, avg2 + (1.0 - spillStrength) * max(0.0, rgb.b - avg2));
  }
  outputColor = vec4(rgb, alpha);
}`;

function dominantChannel(color: Rgb): number {
  if (color[1] > color[0] && color[1] > color[2]) return 1;
  if (color[2] > color[0] && color[2] > color[1]) return 2;
  return 0;
}

export function ChromaPreviewCanvas({
  videoRef,
  settings,
  onUnavailable,
  onReady,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  settings: KeySettings | null;
  onUnavailable: (message: string) => void;
  onReady: () => void;
}): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const chromaSettings = settings?.chroma;
    if (canvas === null || video === null || settings?.mode !== "chroma" || chromaSettings === undefined) {
      return undefined;
    }
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
    if (gl === null) {
      onUnavailable("WebGL2 is unavailable; showing the unkeyed proxy.");
      return undefined;
    }
    const program = gl.createProgram();
    if (program === null) {
      onUnavailable("WebGL2 could not allocate the chroma preview.");
      return undefined;
    }
    try {
      gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) ?? "WebGL chroma-preview link failed.");
      }
    } catch (error: unknown) {
      onUnavailable(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (buffer === null || texture === null) return undefined;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const key = parseColor(chromaSettings.keyColor);
    gl.uniform3fv(gl.getUniformLocation(program, "keyColor"), key);
    gl.uniform1f(gl.getUniformLocation(program, "tolerance"), chromaSettings.tolerance);
    gl.uniform1f(gl.getUniformLocation(program, "softness"), chromaSettings.softness);
    gl.uniform1f(gl.getUniformLocation(program, "spillStrength"), chromaSettings.spill.strength);
    gl.uniform1i(
      gl.getUniformLocation(program, "dominantChannel"),
      chromaSettings.spill.mode === "off" ? 0 : dominantChannel(key),
    );
    onReady();
    let frameRequest = 0;
    let disposed = false;
    const draw = (): void => {
      if (disposed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      canvas.width = Math.max(1, video.videoWidth);
      canvas.height = Math.max(1, video.videoHeight);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (!video.paused) frameRequest = requestAnimationFrame(draw);
    };
    const start = (): void => {
      cancelAnimationFrame(frameRequest);
      draw();
    };
    video.addEventListener("loadeddata", start);
    video.addEventListener("seeked", start);
    video.addEventListener("play", start);
    draw();
    return () => {
      disposed = true;
      cancelAnimationFrame(frameRequest);
      video.removeEventListener("loadeddata", start);
      video.removeEventListener("seeked", start);
      video.removeEventListener("play", start);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [onReady, onUnavailable, settings, videoRef]);

  return settings?.mode === "chroma"
    ? <canvas ref={canvasRef} className="chroma-preview" data-testid="preview-chroma-webgl" />
    : null;
}
