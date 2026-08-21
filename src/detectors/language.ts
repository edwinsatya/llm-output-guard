import { words } from '../internal/tokenize.js';

/**
 * Function-word frequency profiles. Coarse by design: this catches a model
 * answering in the wrong language entirely, not dialect or register drift.
 * Off by default in every preset for exactly that reason.
 *
 * ## How a profile is chosen
 *
 * Not by frequency. The commonest function words of a language are usually the
 * ones its neighbours share, and this detector scores `(best - target) / best`
 * across every profile -- so a word that two languages both own raises `target`
 * as much as `best` and moves the score toward zero. What separates languages
 * is the words where they spell the same idea differently, so that is what the
 * newer profiles are built from: `não`/`no`, `com`/`con`, `em`/`en`, `uma`/`una`
 * for Portuguese against Spanish; `il`/`el`, `di`/`de`, `che`/`que`, `gli` for
 * Italian; `les`/`des`/`du`/`dans`/`avec`/`cette` for French.
 *
 * ## `es` was the weak expectation until 1.7.0
 *
 * It originally held the twenty commonest Spanish function words, which is
 * exactly what the rule above warns against: `de`, `que`, `por`, `para`, `no`,
 * `se`, `como` are shared with Portuguese, Italian or French, so they raised
 * `target` on those languages as much as `best` and the score collapsed. A
 * Portuguese answer scored 0.36 against `expectLang: 'es'` and passed.
 *
 * It is now built the same way as the others, from where Spanish differs:
 * `y`/`e`, `es`/`é`,`è`, `no`/`não`,`non`, `muy`/`muito`,`molto`,
 * `pero`/`mas`,`ma`, `cuando`/`quando`, `donde`/`onde`,`dove`, `sin`/`sem`,
 * `hasta`/`até`. Measured over two unrelated sample sets, a response in
 * another language scored against `'es'`:
 *
 *   pt 0.36 -> 0.91 / 0.50 -> 0.75      it 0.83 -> 1.00 / 0.33 -> 1.00
 *   fr 0.30 -> 1.00 / 0.33 -> 1.00      nl 0.69 -> 1.00 / 0.73 -> 1.00
 *
 * Spanish still scores 0.000 against itself on both sets, and no other
 * expectation's verdict changes -- which is what makes this strictly more
 * accurate rather than a threshold change.
 */
const PROFILES: Record<string, Set<string>> = {
  id: new Set(['yang', 'dan', 'di', 'untuk', 'dengan', 'ini', 'itu', 'dari', 'pada', 'tidak', 'adalah', 'akan', 'bisa', 'kita', 'saya', 'atau', 'juga', 'dalam', 'sudah', 'ke']),
  en: new Set(['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'it', 'with', 'as', 'this', 'are', 'be', 'you', 'on', 'not', 'or', 'can', 'we']),
  es: new Set(['el', 'los', 'las', 'y', 'es', 'no', 'muy', 'pero', 'este', 'esta', 'sus', 'cuando', 'donde', 'porque', 'sin', 'hasta', 'aunque', 'mismo', 'otro', 'todos']),
  pt: new Set(['não', 'é', 'são', 'uma', 'com', 'em', 'do', 'da', 'dos', 'das', 'ao', 'você', 'também', 'muito', 'mais', 'já', 'pelo', 'isso', 'seu', 'sua']),
  it: new Set(['il', 'di', 'che', 'non', 'per', 'della', 'nel', 'nella', 'gli', 'più', 'anche', 'perché', 'questo', 'sono', 'essere', 'dei', 'delle', 'agli', 'però', 'sia']),
  fr: new Set(['les', 'des', 'du', 'qui', 'dans', 'pour', 'sur', 'pas', 'ce', 'est', 'plus', 'nous', 'vous', 'avec', 'cette', 'aux', 'être', 'mais', 'leur', 'tout']),
  de: new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'sich', 'mit', 'den', 'für', 'auf', 'von', 'dem', 'werden', 'oder', 'auch', 'wird', 'kann']),
  nl: new Set(['het', 'een', 'niet', 'zijn', 'worden', 'maar', 'deze', 'wordt', 'ook', 'naar', 'bij', 'over', 'door', 'tussen', 'omdat', 'moet', 'kan', 'heeft', 'dat', 'van']),
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
  /*
   * `Object.hasOwn`, not `expected in PROFILES`. `in` walks the prototype
   * chain, so `expectLang: 'constructor'` passed this guard, then read
   * `Object.prototype.constructor` off the profile as its target share and
   * produced `NaN` -- a score that is neither above nor below any threshold,
   * silently disabling the detector and poisoning any histogram built from it.
   */
  if (!Object.hasOwn(PROFILES, expected)) return 0;
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
