import type { TemplateModule } from "@guyditor/render";
import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";

interface Params {
  label: string;
  from: number;
  value: number;
  decimals: number;
  prefix: string;
  suffix: string;
  accent: string;
  background: string;
  fontFamily: string;
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const progress = motion.easing.sample("ease-out", Math.min(1, ctx.progress * 2.6));
    const width = Math.min(ctx.width * 0.72, 430 * scale);
    const height = 220 * scale;
    const x = (ctx.width - width) / 2;
    const y = (ctx.height - height) / 2;

    g.save();
    g.translate(0, (1 - progress) * 24 * scale);
    g.globalAlpha = progress * Math.min(1, (1 - ctx.progress) * 8);
    motion.shapes.roundedRect(g, {
      x,
      y,
      width,
      height,
      radius: 8 * scale,
      fill: params.background,
      stroke: "#102A43",
      strokeWidth: 2 * scale,
    });
    motion.charts.pie(g, {
      values: [params.value, Math.max(0, 100 - params.value)],
      colors: [params.accent, "rgba(16,42,67,0.14)"],
      centerX: x + 74 * scale,
      centerY: y + 104 * scale,
      radius: 47 * scale,
      progress,
    });
    motion.charts.counter(g, {
      from: params.from,
      to: params.value,
      progress,
      decimals: params.decimals,
      prefix: params.prefix,
      suffix: params.suffix,
      x: x + 144 * scale,
      y: y + 112 * scale,
      font: `600 ${String(58 * scale)}px "${params.fontFamily}"`,
      fill: "#102A43",
    });
    g.fillStyle = "#102A43";
    g.font = `600 ${String(17 * scale)}px "${params.fontFamily}"`;
    g.fillText(params.label, x + 144 * scale, y + 150 * scale, width - 168 * scale);
    g.restore();
  },
};

export default template;
