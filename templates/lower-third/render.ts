import type { TemplateModule } from "@guyditor/render";

interface Params {
  title: string;
  subtitle: string;
  accent: string;
  position: "left" | "right";
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const width = Math.min(ctx.width * 0.57, 500 * scale);
    const height = 78 * scale;
    const reveal = Math.min(1, ctx.progress * 7);
    const exit = Math.min(1, (1 - ctx.progress) * 9);
    const opacity = Math.min(reveal, exit);
    const baseX = params.position === "left"
      ? ctx.safeArea.left
      : ctx.width - ctx.safeArea.right - width;
    const direction = params.position === "left" ? -1 : 1;
    const x = baseX + direction * (1 - reveal) * 34 * scale;
    const y = ctx.height - ctx.safeArea.bottom - height;

    g.save();
    g.globalAlpha = opacity;
    g.fillStyle = "rgba(12, 18, 23, 0.94)";
    g.fillRect(x, y, width, height);
    g.fillStyle = params.accent;
    g.fillRect(params.position === "left" ? x : x + width - 7 * scale, y, 7 * scale, height);
    g.fillStyle = "#F4F7F5";
    g.font = `600 ${String(25 * scale)}px "Inconsolata Guyditor"`;
    g.textBaseline = "alphabetic";
    g.fillText(params.title, x + 24 * scale, y + 34 * scale, width - 45 * scale);
    g.fillStyle = "rgba(244, 247, 245, 0.72)";
    g.font = `400 ${String(15 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.subtitle, x + 24 * scale, y + 59 * scale, width - 45 * scale);
    g.restore();
  },
};

export default template;
