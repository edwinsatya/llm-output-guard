import { words } from '../internal/tokenize.js';

/**
 * Function-word frequency profiles. Coarse by design: this catches a model
 * answering in the wrong language entirely, not dialect or register drift.
 * Off by default in every preset for exactly that reason.
 */
const PROFILES: Record<string, Set<string>> = {
  id: new Set(['yang', 'dan', 'di', 'untuk', 'dengan', 'ini', 'itu', 'dari', 'pada', 'tidak', 'adalah', 'akan', 'bisa', 'kita', 'saya', 'atau', 'juga', 'dalam', 'sudah', 'ke']),
  en: new Set(['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'as', 'this', 'are', 'be', 'you', 'on', 'not', 'or', 'can', 'we']),
  es: new Set(['el', 'la', 'de', 'que', 'y', 'en', 'los', 'un', 'por', 'con', 'las', 'para', 'una', 'es', 'no', 'se', 'del', 'al', 'lo', 'como']),
};

export interface LanguageOptions {
  /** Below this word count the signal is unreliable and the score is 0. */
  minWords?: number;
}

/** Share of tokens matching each known profile. Not a full language detector. */
export function languageProfile(text: string): Record<string, number> {
  const w = words(text);
  const out: Record<string, number> = {};
  if (w.length === 0) return out;
  for (const [lang, set] of Object.entries(PROFILES)) {
    let hits = 0;
    for (const token of w) if (set.has(token)) hits++;
    out[lang] = hits / w.length;
  }
  return out;
}

/**
 * Suspicion that the response is not in `expected`.
 * Returns 0 for unknown languages or samples too short to judge --
 * silence is better than a confident wrong answer here.
 */
export function languageMismatchScore(
  text: string,
  expected: string,
  options: LanguageOptions = {},
): number {
  const { minWords = 25 } = options;
  if (!(expected in PROFILES)) return 0;
  const w = words(text);
  if (w.length < minWords) return 0;

  const profile = languageProfile(text);
  const target = profile[expected] ?? 0;
  const best = Math.max(...Object.values(profile));
  if (best === 0) return 0;
  if (target >= best) return 0;
  return Math.min(1, (best - target) / best);
}

export const supportedLanguages = Object.keys(PROFILES);
