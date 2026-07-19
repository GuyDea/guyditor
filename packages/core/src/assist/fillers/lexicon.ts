import english from "./lexicon.en.json" with { type: "json" };

export type DisfluencyTag = "filler" | "discourse";

export interface DisfluencyLexiconEntry {
  phrase: string;
  tag: DisfluencyTag;
}

export interface DisfluencyLexicon {
  language: string;
  entries: readonly DisfluencyLexiconEntry[];
}

const lexicons = new Map<string, DisfluencyLexicon>([
  [english.language, {
    language: english.language,
    entries: english.entries.map(({ phrase, tag }) => ({
      phrase,
      tag: tag as DisfluencyTag,
    })),
  }],
]);

export function fillerLexicon(language: string): DisfluencyLexicon {
  const normalized = language.toLowerCase().split("-")[0] ?? language;
  return lexicons.get(normalized) ?? lexicons.get("en")!;
}
