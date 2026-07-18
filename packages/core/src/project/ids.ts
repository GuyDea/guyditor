import { randomBytes } from "node:crypto";

export const ID_PREFIXES = [
  "ast",
  "clp",
  "seq",
  "lyr",
  "trn",
  "cts",
  "ann",
  "dlv",
  "pre",
  "tpl",
  "skl",
  "beat",
  "mrk",
  "tak",
  "ses",
  "job",
  "txn",
  "prp",
  "adp",
  "prj",
  "fx",
  "gfx",
  "msk",
  "kfr",
  "avr",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];
export type GuyditorId<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const RANDOM_ID_LENGTH = 10;

export const ID_PATTERNS = Object.freeze(
  Object.fromEntries(
    ID_PREFIXES.map((prefix) => [
      prefix,
      new RegExp(`^${prefix}_[a-z2-7]{10}$`),
    ]),
  ) as Record<IdPrefix, RegExp>,
);

export const WORD_ID_PATTERN = /^w[0-9]{6}$/;
export const REVISION_ID_PATTERN = /^rev_[0-9]{5}$/;

export function makeId<P extends IdPrefix>(prefix: P): GuyditorId<P> {
  const bytes = randomBytes(RANDOM_ID_LENGTH);
  let suffix = "";
  for (const byte of bytes) suffix += BASE32_ALPHABET[byte & 31];
  return `${prefix}_${suffix}` as GuyditorId<P>;
}

export function isId<P extends IdPrefix>(
  prefix: P,
  value: unknown,
): value is GuyditorId<P> {
  return typeof value === "string" && ID_PATTERNS[prefix].test(value);
}

function formatOrdinal(
  value: number,
  maximum: number,
  width: number,
  prefix: string,
): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(
      `${prefix} ordinal must be an integer from 0 through ${String(maximum)}.`,
    );
  }
  return `${prefix}${String(value).padStart(width, "0")}`;
}

function parseOrdinal(
  value: string,
  pattern: RegExp,
  prefixLength: number,
  kind: string,
): number {
  if (!pattern.test(value)) throw new RangeError(`${kind} ID is malformed.`);
  return Number(value.slice(prefixLength));
}

export function formatWordId(ordinal: number): string {
  return formatOrdinal(ordinal, 999_999, 6, "w");
}

export function parseWordId(value: string): number {
  return parseOrdinal(value, WORD_ID_PATTERN, 1, "Word");
}

export function formatRevision(revision: number): string {
  return formatOrdinal(revision, 99_999, 5, "rev" + "_");
}

export function parseRevision(value: string): number {
  return parseOrdinal(value, REVISION_ID_PATTERN, 4, "Revision");
}
