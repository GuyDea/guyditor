import type { TemplateModule } from "@guyditor/render";
import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";

interface Params {
  eyebrow: string;
  title: string;
  accent: string;
  background: string;
  fontFamily: string;
  logoSlot: "none" | "brand";
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const enter = motion.easing.sample("ease-out", Math.min(1, ctx.progress * 3.8));
    const exit = motion.easing.sample("ease-in", Math.min(1, (1 - ctx.progress) * 8));
    const left = ctx.safeArea.left + 20 * scale;
    const top = ctx.safeArea.top + 34 * scale;

    g.save();
    g.globalAlpha = Math.min(enter, exit);
    motion.texture.fill(g, {
      kind: "dots",
      x: 0,
      y: 0,
      width: ctx.width,
      height: ctx.height,
      foreground: "rgba(255,255,255,0.16)",
      background: params.background,
      spacing: 18 * scale,
      size: 1.1 * scale,
      seed: 1968,
    });
    motion.shapes.roundedRect(g, {
      x: left,
      y: top,
      width: 128 * scale * enter,
      height: 24 * scale,
      radius: 2 * scale,
      fill: params.accent,
    });
    g.fillStyle = params.background;
    g.font = `600 ${String(12 * scale)}px "${params.fontFamily}"`;
    g.fillText(params.eyebrow.toUpperCase(), left + 8 * scale, top + 16 * scale);
    motion.text.drawReveal(g, {
      text: params.title,
      mode: "word",
      easing: "ease-out",
      progress: Math.max(0, Math.min(1, ctx.progress * 2.2 - 0.12)),
      x: left,
      y: ctx.height * 0.58,
      font: `600 ${String(48 * scale)}px "${params.fontFamily}"`,
      fill: "#FFFFFF",
      maxWidth: ctx.width - left - ctx.safeArea.right,
    });
    if (params.logoSlot === "brand" && ctx.brand.logoSlots?.brand !== undefined) {
      g.drawImage(
        ctx.brand.logoSlots.brand,
        ctx.width - ctx.safeArea.right - 92 * scale,
        ctx.height - ctx.safeArea.bottom - 30 * scale,
        92 * scale,
        30 * scale,
      );
    }
    g.restore();
  },
};

export default template;
