import type { TemplateModule } from "@guyditor/render";

interface Params {
  eyebrow: string;
  title: string;
  subtitle: string;
  accent: string;
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const reveal = Math.min(1, ctx.progress * 5);
    const opacity = Math.min(reveal, Math.min(1, (1 - ctx.progress) * 7));
    const x = ctx.safeArea.left + 14 * scale;
    const centerY = ctx.height * 0.48;

    g.save();
    g.globalAlpha = opacity;
    g.fillStyle = params.accent;
    g.fillRect(x, centerY - 85 * scale, 48 * scale * reveal, 4 * scale);
    g.fillStyle = params.accent;
    g.font = `600 ${String(14 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.eyebrow.toUpperCase(), x, centerY - 50 * scale);
    g.fillStyle = "#FFFFFF";
    g.font = `600 ${String(40 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.title, x, centerY + 4 * scale, ctx.width - x - ctx.safeArea.right);
    g.fillStyle = "rgba(255, 255, 255, 0.72)";
    g.font = `400 ${String(19 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.subtitle, x, centerY + 43 * scale, ctx.width - x - ctx.safeArea.right);
    g.restore();
  },
};

export default template;
