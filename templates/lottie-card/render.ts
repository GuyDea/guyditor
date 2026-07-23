import type { TemplateModule } from "@guyditor/render";
import { primitivesV1 as motion } from "@guyditor/render/primitives/v1";

interface Params {
  accent: string;
  surface: string;
  ink: string;
}

const template: TemplateModule<Params> = {
  render(ctx, params) {
    const width = Math.min(ctx.width * 0.76, ctx.height * 1.42);
    const height = width * 180 / 320;
    motion.lottie.draw(ctx.canvas, {
      animation: ctx.lottie("card-motion"),
      frame: ctx.frame,
      x: (ctx.width - width) / 2,
      y: (ctx.height - height) / 2,
      width,
      height,
      colorSlots: {
        accent: params.accent,
        surface: params.surface,
        ink: params.ink,
      },
    });
  },
};

export default template;
