import type { TemplateModule } from "@guyditor/render";

interface Params {
  title: string;
  body: string;
  accent: string;
  logoSlot: "none" | "brand";
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const reveal = Math.min(1, ctx.progress * 5);
    const opacity = Math.min(reveal, Math.min(1, (1 - ctx.progress) * 6));
    const left = ctx.safeArea.left + 34 * scale;
    const width = ctx.width - left - ctx.safeArea.right - 34 * scale;

    g.save();
    g.globalAlpha = opacity;
    g.fillStyle = "#10171C";
    g.fillRect(0, 0, ctx.width, ctx.height);
    g.fillStyle = params.accent;
    g.fillRect(0, 0, 12 * scale * reveal, ctx.height);
    g.fillRect(left, ctx.height * 0.27, 62 * scale * reveal, 5 * scale);
    g.fillStyle = "#FFFFFF";
    g.font = `600 ${String(40 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.title, left, ctx.height * 0.46, width);
    g.fillStyle = "rgba(255, 255, 255, 0.72)";
    g.font = `400 ${String(19 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.body, left, ctx.height * 0.59, width);
    if (params.logoSlot === "brand") {
      const logo = ctx.brand.logoSlots?.brand;
      if (logo === undefined) {
        g.strokeStyle = params.accent;
        g.lineWidth = 2 * scale;
        g.strokeRect(left, ctx.height - ctx.safeArea.bottom - 30 * scale, 68 * scale, 20 * scale);
        g.fillStyle = params.accent;
        g.font = `600 ${String(10 * scale)}px "Inconsolata Guyditor"`;
        g.fillText("YOUR LOGO", left + 8 * scale, ctx.height - ctx.safeArea.bottom - 16 * scale);
      } else {
        g.drawImage(logo, left, ctx.height - ctx.safeArea.bottom - 36 * scale, 90 * scale, 30 * scale);
      }
    }
    g.restore();
  },
};

export default template;
