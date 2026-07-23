import type { TemplateModule } from "@guyditor/render";
import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";

interface Params {
  text: string;
  accent: string;
  textColor: string;
  fontFamily: string;
}

const template: TemplateModule<Params> = {
  duration() {
    return { mode: "anchor_span" };
  },
  render(ctx, params) {
    const g = ctx.canvas;
    const scale = ctx.height / 360;
    const x = ctx.safeArea.left + 26 * scale;
    const y = ctx.height - ctx.safeArea.bottom - 46 * scale;
    const reveal = motion.text.reveal({
      text: params.text,
      mode: "word",
      easing: "linear",
      progress: ctx.progress,
      timeline: ctx.timeline,
      wordTiming: ctx.wordTiming,
    });

    g.save();
    g.font = `600 ${String(31 * scale)}px "${params.fontFamily}"`;
    const width = Math.max(32 * scale, g.measureText(params.text).width);
    motion.wipes.withRect(g, {
      direction: "left-to-right",
      progress: reveal.progress,
      easing: "ease-out",
      x,
      y: y - 36 * scale,
      width,
      height: 44 * scale,
    }, () => {
      g.fillStyle = params.accent;
      g.fillRect(x, y + 5 * scale, width, 6 * scale);
    });
    g.fillStyle = params.textColor;
    g.fillText(params.text, x, y);
    g.restore();
  },
};

export default template;
