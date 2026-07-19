import type { TemplateModule } from "@guyditor/render";

interface Params {
  label: string;
  body: string;
  accent: string;
  pointer: "top" | "right" | "bottom" | "left";
}

const template: TemplateModule<Params> = {
  duration(params, media) {
    const seconds = Math.max(2.5, Math.min(7, 1.8 + params.body.length / 18));
    const [numeratorText, denominatorText] = media.fps.split("/");
    const fps = Number(numeratorText) / Number(denominatorText);
    return { mode: "fixed", frames: Math.max(1, Math.round(seconds * fps)), fps: media.fps };
  },
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const width = Math.min(300 * scale, ctx.width * 0.54);
    const height = 94 * scale;
    const x = ctx.width - ctx.safeArea.right - width;
    const y = ctx.safeArea.top + 38 * scale;
    const reveal = Math.min(1, ctx.progress * 8);
    const opacity = Math.min(reveal, Math.min(1, (1 - ctx.progress) * 9));

    g.save();
    g.globalAlpha = opacity;
    g.fillStyle = "rgba(15, 20, 24, 0.95)";
    g.fillRect(x, y, width, height);
    g.strokeStyle = params.accent;
    g.lineWidth = 2 * scale;
    g.strokeRect(x, y, width, height);
    g.fillStyle = params.accent;
    g.font = `600 ${String(13 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.label.toUpperCase(), x + 18 * scale, y + 28 * scale);
    g.fillStyle = "#FFFFFF";
    g.font = `400 ${String(17 * scale)}px "Inconsolata Guyditor"`;
    g.fillText(params.body, x + 18 * scale, y + 61 * scale, width - 36 * scale);
    const tipX = params.pointer === "left" ? x - 18 * scale
      : params.pointer === "right" ? x + width + 18 * scale : x + width * 0.72;
    const tipY = params.pointer === "top" ? y - 18 * scale
      : params.pointer === "bottom" ? y + height + 18 * scale : y + height * 0.72;
    const edgeX = params.pointer === "left" ? x
      : params.pointer === "right" ? x + width : x + width * 0.72;
    const edgeY = params.pointer === "top" ? y
      : params.pointer === "bottom" ? y + height : y + height * 0.72;
    g.beginPath();
    g.moveTo(edgeX, edgeY);
    g.lineTo(tipX, tipY);
    g.stroke();
    g.restore();
  },
};

export default template;
