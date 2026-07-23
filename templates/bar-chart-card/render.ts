import type { TemplateModule } from "@guyditor/render";
import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";

interface Params {
  title: string;
  valueA: number;
  valueB: number;
  valueC: number;
  maximum: number;
  accent: string;
  background: string;
  fontFamily: string;
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const progress = motion.easing.sample("ease-out", Math.min(1, ctx.progress * 2.8));
    const x = ctx.safeArea.left + 38 * scale;
    const y = ctx.safeArea.top + 34 * scale;
    const width = ctx.width - x - ctx.safeArea.right - 38 * scale;
    const chartHeight = ctx.height - y - ctx.safeArea.bottom - 72 * scale;

    g.fillStyle = params.background;
    g.fillRect(0, 0, ctx.width, ctx.height);
    motion.texture.fill(g, {
      kind: "stripes",
      x: 0,
      y: 0,
      width: ctx.width,
      height: ctx.height,
      foreground: "rgba(255,255,255,0.05)",
      spacing: 28 * scale,
      size: 2 * scale,
    });
    g.fillStyle = "#FFFFFF";
    g.font = `600 ${String(24 * scale)}px "${params.fontFamily}"`;
    g.fillText(params.title, x, y + 18 * scale);
    motion.charts.bar(g, {
      values: [params.valueA, params.valueB, params.valueC],
      max: params.maximum,
      x,
      y: y + 46 * scale,
      width,
      height: chartHeight,
      color: params.accent,
      gap: 20 * scale,
      progress,
    });
    motion.charts.line(g, {
      values: [params.valueA, params.valueB, params.valueC],
      min: 0,
      max: params.maximum,
      x: x + width / 6,
      y: y + 46 * scale,
      width: width * 2 / 3,
      height: chartHeight,
      color: "#FF6B57",
      strokeWidth: 4 * scale,
      progress,
    });
  },
};

export default template;
