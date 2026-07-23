import type { TemplateModule } from "@guyditor/render";
import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";

interface Params {
  eyebrow: string;
  title: string;
  accent: string;
  background: string;
  fontFamily: string;
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const progress = motion.easing.sample("ease-out", Math.min(1, ctx.progress * 3));
    const portraitWidth = 238 * scale;
    const portraitHeight = 268 * scale;
    const portraitX = ctx.width - ctx.safeArea.right - portraitWidth - 10 * scale;
    const portraitY = ctx.height - ctx.safeArea.bottom - portraitHeight;

    g.fillStyle = params.background;
    g.fillRect(0, 0, ctx.width, ctx.height);
    motion.shapes.polygon(g, {
      points: [
        { x: 0, y: ctx.height * 0.72 },
        { x: ctx.width * 0.68, y: ctx.height * 0.43 },
        { x: ctx.width, y: ctx.height * 0.78 },
        { x: ctx.width, y: ctx.height },
        { x: 0, y: ctx.height },
      ],
      fill: params.accent,
    });
    g.save();
    g.translate((1 - progress) * 56 * scale, 0);
    motion.cutout.place(g, {
      image: ctx.staticAssets("portrait-cutout"),
      x: portraitX,
      y: portraitY,
      width: portraitWidth,
      height: portraitHeight,
      border: { width: 5 * scale, color: "#FFFFFF" },
      shadow: { dx: -10 * scale, dy: 12 * scale, blur: 14 * scale, color: "rgba(16,42,67,0.36)" },
    });
    g.restore();
    const left = ctx.safeArea.left + 20 * scale;
    g.fillStyle = "#FF6B57";
    g.font = `600 ${String(13 * scale)}px "${params.fontFamily}"`;
    g.fillText(params.eyebrow, left, ctx.height * 0.31);
    motion.text.drawReveal(g, {
      text: params.title,
      mode: "character",
      easing: "ease-out",
      progress,
      x: left,
      y: ctx.height * 0.49,
      font: `600 ${String(36 * scale)}px "${params.fontFamily}"`,
      fill: "#102A43",
      maxWidth: ctx.width * 0.54,
    });
  },
};

export default template;
