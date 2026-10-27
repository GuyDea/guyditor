import { describe, expect, it } from "vitest";
import { messageText, textMessage, type LlmMessage } from "./types.js";

describe("messageText", () => {
  it("joins text parts and skips binary parts", () => {
    const message: LlmMessage = {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image", mime: "image/png", data: new Uint8Array([1]), label: "F1", name: "x.png" },
        { type: "text", text: "b" },
        { type: "pdf", mime: "application/pdf", data: new Uint8Array([1]), label: "F2", name: "y.pdf" },
      ],
    };
    expect(messageText(message)).toBe("a\nb");
    expect(messageText(textMessage("validation", "c"))).toBe("c");
  });
});
