/**
 * Script-level language mismatch.
 *
 * The sibling of `languageMismatchScore`, and the stronger of the two wherever
 * both apply. That one reads function words, so it knows three languages, needs
 * 25 of them before it will speak, and is answering a hard question -- *which
 * language is this?* This one answers an easy one: *is this even written in the
 * alphabet I asked for?* A model that was asked for English and replied in
 * Chinese, Russian or Arabic is caught by counting characters, with no word
 * list, no training data, and no minimum that a two-sentence reply cannot meet.
 *
 * It is deliberately blind to everything finer. Spanish against English, or
 * Indonesian against Malay, are the same script and score exactly 0 here --
 * that is `expectLang`'s job and this detector does not pretend to it.
 */
import { clamp01 } from '../internal/tokenize.js';

/**
 * Scripts this detector can be asked for.
 *
 * `kana` covers Hiragana and Katakana together because no caller wants them
 * apart: Japanese uses both in the same sentence, so a profile that separated
 * them would only ever be passed as a pair.
 */
export type ScriptName =
  | 'latin'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'cyrillic'
  | 'arabic'
  | 'devanagari'
  | 'greek'
  | 'hebrew'
  | 'thai';

const SCRIPTS: Record<ScriptName, RegExp> = {
  latin: /\p{Script=Latin}/u,
  han: /\p{Script=Han}/u,
  kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  hangul: /\p{Script=Hangul}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  arabic: /\p{Script=Arabic}/u,
  devanagari: /\p{Script=Devanagari}/u,
  greek: /\p{Script=Greek}/u,
  hebrew: /\p{Script=Hebrew}/u,
  thai: /\p{Script=Thai}/u,
};

/** Every script name {@link scriptMismatchScore} accepts. */
export const supportedScripts = Object.keys(SCRIPTS) as ScriptName[];

/** Letters and marks -- the only characters that carry script evidence. */
const LETTER_OR_MARK = /[\p{L}\p{M}]/gu;

/**
 * Characters that belong to no script in particular, removed from both sides
 * of the ratio.
 *
 * This is not tidiness, it is the difference between `café` written with a
 * precomposed `é` and the same word written with a combining acute. The
 * combining mark is `Script=Inherited`, so without this it counts as a letter
 * that is *not* Latin -- and a Latin response scores a mismatch for its
 * accents. Thai vowel and tone marks are `Script=Thai` and are unaffected,
 * which is the same asymmetry `nonSpacedRatio` documents.
 */
const SCRIPT_NEUTRAL = /[\p{sc=Common}\p{sc=Inherited}]/u;

/*
 * Spans whose characters say nothing about what language the model answered
 * in. A Chinese answer explaining a TypeScript snippet is still a Chinese
 * answer, and the identifiers inside the fence are Latin because TypeScript is.
 * Counting them is how you fail a correct response.
 *
 * The trailing-fence pattern matters more than it looks: mid-stream and on a
 * truncated response the last fence is open, and leaving it in would put a
 * whole code block back into the denominator at exactly the moment the text is
 * least representative.
 */
const FENCED_BLOCK = /```[\s\S]*?```/g;
const OPEN_FENCE_TO_END = /```[\s\S]*$/;
const INLINE_CODE = /`[^`\n]*`/g;
const URL = /\bhttps?:\/\/\S+/gi;

const stripNonLinguistic = (text: string): string =>
  text
    .replace(FENCED_BLOCK, ' ')
    .replace(OPEN_FENCE_TO_END, ' ')
    .replace(INLINE_CODE, ' ')
    .replace(URL, ' ');

export interface ScriptOptions {
  /**
   * Letters required before the detector will judge at all. Default 12.
   *
   * Low, because script evidence does not need a sample the way a function-word
   * profile does -- twelve Han characters are twelve independent votes, where
   * twelve English words might contain one function word. It is not zero
   * because `{"id":42}` has four letters and no opinion about language.
   */
  minLetters?: number;
  /**
   * Drop code fences, inline code and URLs before measuring. Default true.
   *
   * Turn it off only if you expect the *code* to be in the script you asked
   * for, which is not a thing code does.
   */
  ignoreCode?: boolean;
  /** Only analyse the first N characters. Keeps cost bounded on long outputs. */
  maxSample?: number;
}

/**
 * Share of judgeable letters written in each known script, plus `other`.
 *
 * Shares sum to 1 across a response, except that a character belonging to two
 * of these scripts would be counted in both -- none of the ten overlap, so in
 * practice they sum to 1 exactly.
 */
export function scriptProfile(text: string, options: ScriptOptions = {}): Record<string, number> {
  const letters = judgeableLetters(text, options);
  const out: Record<string, number> = {};
  if (letters.length === 0) return out;

  let classified = 0;
  for (const name of supportedScripts) {
    const re = SCRIPTS[name];
    let hits = 0;
    for (const ch of letters) if (re.test(ch)) hits++;
    classified += hits;
    out[name] = hits / letters.length;
  }
  out.other = (letters.length - classified) / letters.length;
  return out;
}

/**
 * Suspicion that the response is not written in `expected`.
 *
 * The score is the share of judgeable letters in a script that was not asked
 * for -- linear, and readable as what it is: `0.9` means nine letters in ten
 * are in the wrong alphabet. A stray proper noun or a borrowed technical term
 * moves it a few points; answering the whole question in the wrong language
 * moves it to 1.
 *
 * Pass every script the answer may legitimately contain. Japanese needs
 * `['han', 'kana']` and technical Japanese usually wants `'latin'` alongside
 * them, for the same reason a Chinese answer about React contains `useEffect`.
 *
 * Returns 0 -- abstains -- for an unknown script name, and for a sample with
 * too few letters to judge. Never throws.
 */
export function scriptMismatchScore(
  text: string,
  expected: ScriptName | readonly ScriptName[],
  options: ScriptOptions = {},
): number {
  const { minLetters = 12 } = options;

  const wanted = (Array.isArray(expected) ? expected : [expected]) as readonly ScriptName[];
  /*
   * `Object.hasOwn`, not `name in SCRIPTS`, and for the reason 1.3.1 fixed in
   * `requiredKeys`: `in` walks the prototype chain, so `expectScript:
   * 'constructor'` would resolve to `Object.prototype.constructor`, be called
   * as a regex, and throw from inside a package that promises never to.
   */
  const known = wanted.filter((name) => typeof name === 'string' && Object.hasOwn(SCRIPTS, name));
  // An expectation naming nothing this detector knows is not evidence that the
  // response is wrong -- it is evidence the option was misspelled. Abstain.
  if (known.length === 0) return 0;

  const letters = judgeableLetters(text, options);
  if (letters.length < minLetters) return 0;

  let matched = 0;
  for (const ch of letters) {
    for (const name of known) {
      if (SCRIPTS[name].test(ch)) {
        matched++;
        break;
      }
    }
  }

  return clamp01(1 - matched / letters.length);
}

/**
 * The characters both functions above count: letters and marks, outside code
 * and URLs, that belong to some script.
 */
function judgeableLetters(text: string, options: ScriptOptions): string[] {
  const { ignoreCode = true, maxSample = 8000 } = options;
  const source = ignoreCode ? stripNonLinguistic(text.slice(0, maxSample)) : text.slice(0, maxSample);
  const found = source.match(LETTER_OR_MARK);
  if (!found) return [];
  return found.filter((ch) => !SCRIPT_NEUTRAL.test(ch));
}
