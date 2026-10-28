import { type LlmContentPart, type LlmMessage, type LlmRole } from "./types.js";

type BinaryPart = Exclude<LlmContentPart, { type: "text" }>;

const SPEAKER: Record<LlmRole, string> = { user: "Creator", assistant: "Assistant", validation: "Validation" };

/** The file name a binary part is written under in the context directory, e.g. "F2-storyboard.png". */
export function cliFileName(part: BinaryPart): string {
  return `${part.label}-${part.name}`;
}

/** "F2-storyboard.png (F2), F3-deck.pdf (F3)" — the label is the file name up to its first "-". */
export function cliFileList(files: readonly string[]): string {
  return files.map((file) => `${file} (${file.slice(0, file.indexOf("-"))})`).join(", ");
}

/**
 * The conversation as one prompt: a "Creator:" / "Assistant:" / "Validation:" block per message,
 * blocks separated by a blank line, binary parts referenced inline by their file in the context
 * directory. `images` and `pdfs` list those files in message order, without duplicates.
 */
export function renderCliConversation(messages: LlmMessage[]): { conversation: string; images: string[]; pdfs: string[] } {
  const images = new Set<string>();
  const pdfs = new Set<string>();
  const blocks = messages.map(({ role, content }) => {
    const lines = content.map((part) => {
      if (part.type === "text") return part.text;
      const file = cliFileName(part);
      (part.type === "pdf" ? pdfs : images).add(file);
      return `[${part.label} ${part.name} — see file ${file}]`;
    });
    return `${SPEAKER[role]}: ${lines.join("\n")}`;
  });
  return { conversation: blocks.join("\n\n"), images: [...images], pdfs: [...pdfs] };
}
