/**
 * `llm-output-guard calibrate` -- turn a week of logged scores into thresholds.
 *
 * Reads JSONL from a file or stdin. Deliberately liberal about shape: the
 * whole point is to accept whatever you already log rather than making you
 * reshape it first, because a calibration step you have to prepare for is one
 * you do not run.
 */
import { readFileSync } from 'node:fs';
import { calibrate, type ScoreSample } from './calibrate.js';
import type { ReasonCode, TokenMode } from './types.js';

const CODES: ReasonCode[] = [
  'EMPTY',
  'TOO_SHORT',
  'REPETITION',
  'TAIL_LOOP',
  'LOW_ENTROPY',
  'TRUNCATED',
  'INVALID_JSON',
  'SCRIPT_MISMATCH',
  'LANG_MISMATCH',
  'PROMPT_ECHO',
];

/**
 * The option each detector's threshold is set with, for the detectors whose
 * threshold is a 0..1 score.
 *
 * `EMPTY` is absent because its threshold is not configurable, and `TOO_SHORT`
 * because `minLength` is a character count -- suggesting a 0..1 score for it
 * would print a confidently wrong number in the right-looking place. Both are
 * still reported below as incidence rates, which is the useful thing to know
 * about them anyway.
 */
const OPTION_FOR: Partial<Record<ReasonCode, string>> = {
  REPETITION: 'maxRepetition',
  TAIL_LOOP: 'maxTailLoop',
  LOW_ENTROPY: 'maxCompressibility',
  TRUNCATED: 'maxTruncation',
  SCRIPT_MISMATCH: 'maxScriptMismatch',
  LANG_MISMATCH: 'maxLangMismatch',
  PROMPT_ECHO: 'maxPromptEcho',
};

/**
 * Where a detector's char-mode scores set a different option. Suggesting
 * `maxTailLoop` from a char-mode distribution would print the right-looking
 * number against the wrong knob, and it would be applied to spaced-script
 * traffic that never produced it.
 */
const CHAR_OPTION_FOR: Partial<Record<ReasonCode, string>> = {
  TAIL_LOOP: 'maxCharTailLoop',
};

const optionFor = (code: ReasonCode, mode?: TokenMode): string | undefined =>
  (mode === 'char' ? CHAR_OPTION_FOR[code] : undefined) ?? OPTION_FOR[code];

/** Detectors reported by how often they fired rather than by threshold. */
const RATE_ONLY: Partial<Record<ReasonCode, string>> = {
  EMPTY: 'not configurable — this is how often you served nothing at all',
  TOO_SHORT: 'set by minLength, a character count, which a 0..1 score cannot suggest',
};

/**
 * Dig a scores object out of a logged line.
 *
 * Handles the bare object, a whole `Verdict`, and the common case of a verdict
 * buried in a wider log record. Anything with at least one known reason code
 * mapped to a number counts; anything else is skipped rather than guessed at.
 */
export function extractScores(value: unknown): ScoreSample | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;

  /*
   * On a Verdict, `modes` is a sibling of `scores` -- so by the time recursion
   * reaches the object holding the numbers, the modes are one level up and
   * already out of scope. Read them here and hand them down, so a verdict
   * logged whole segments correctly and a bare scores object still works.
   */
  const modes = extractModes(record.modes);

  for (const nested of [record.scores, record.verdict, record.guard]) {
    const found = nested ? extractScores(nested) : null;
    if (found) return modes && !found.modes ? { ...found, modes } : found;
  }

  const sample: ScoreSample = {};
  let hits = 0;
  for (const code of CODES) {
    const score = record[code];
    if (typeof score === 'number' && Number.isFinite(score)) {
      sample[code] = score;
      hits += 1;
    }
  }
  if (hits === 0) return null;

  if (modes) sample.modes = modes;
  return sample;
}

/** The `modes` map off a logged verdict, keeping only values we recognise. */
function extractModes(value: unknown): Partial<Record<ReasonCode, TokenMode>> | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const modes: Partial<Record<ReasonCode, TokenMode>> = {};
  for (const code of CODES) {
    const mode = raw[code];
    if (mode === 'word' || mode === 'char') modes[code] = mode;
  }
  return Object.keys(modes).length > 0 ? modes : null;
}

function parseLines(text: string): { samples: ScoreSample[]; skipped: number } {
  const samples: ScoreSample[] = [];
  let skipped = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const scores = extractScores(JSON.parse(trimmed));
      if (scores) samples.push(scores);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }

  return { samples, skipped };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const USAGE = `
llm-output-guard calibrate — derive thresholds from your own logged scores

  npx llm-output-guard calibrate scores.jsonl
  cat scores.jsonl | npx llm-output-guard calibrate

Options
  --fpr <rate>   share of traffic you accept flagging (default 0.001)
  --json         emit the calibration as JSON instead of a report

Input is JSONL, one logged verdict per line. A bare scores object, a whole
Verdict, or a wider log record containing either all work:

  {"REPETITION":0.03,"TAIL_LOOP":0}
  {"ok":true,"scores":{"REPETITION":0.03},"reasons":[]}
  {"msg":"reply","verdict":{"scores":{"REPETITION":0.03}}}

Log them with onVerdict:

  outputGuard({ ...presets.chat, onDegenerate: 'ignore',
                onVerdict: (v) => log.info({ scores: v.scores, modes: v.modes }) })

Include modes if your traffic is not all one script. TAIL_LOOP measured over
words and over characters are different distributions, and this segments them
into TAIL_LOOP [word] and TAIL_LOOP [char] so each gets its own threshold.
Without it they are pooled, and the suggestion fits neither.
`;

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '  -  ');

function report(text: string, fpr: number, asJson: boolean): number {
  const { samples, skipped } = parseLines(text);

  if (samples.length === 0) {
    process.stderr.write(
      `No scores found${skipped ? ` (${skipped} lines had none)` : ''}.\n` +
        'Expected JSONL with reason codes such as REPETITION or TAIL_LOOP.\n',
    );
    return 1;
  }

  const result = calibrate(samples, { falsePositiveRate: fpr });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const out: string[] = [
    '',
    `${result.n.toLocaleString()} verdicts` +
      (skipped ? `, ${skipped.toLocaleString()} lines skipped` : '') +
      ` — flagging budget ${(fpr * 100).toFixed(2)}% of traffic`,
  ];

  /*
   * A caveat every detector shares is a fact about the sample, not about any
   * one of them. Repeating it per section buries the ones that are specific,
   * which are the ones worth reading.
   */
  const shared = result.summaries[0].caveats.filter((c) =>
    result.summaries.every((s) => s.caveats.includes(c)),
  );
  for (const caveat of shared) out.push(`! ${caveat}`);

  for (const s of result.summaries) {
    const d = s.distribution;
    // The mode is part of the identity of these numbers, not a footnote: the
    // same code appears twice when traffic mixes scripts.
    out.push('', `${s.code}${s.mode ? ` [${s.mode}]` : ''}   n=${d.n.toLocaleString()}`);
    out.push(
      `  p50 ${fmt(d.p50)}   p90 ${fmt(d.p90)}   p99 ${fmt(d.p99)}   ` +
        `p99.9 ${fmt(d.p999)}   max ${fmt(d.max)}`,
    );

    if (s.gap) {
      out.push(
        `  gap ${fmt(s.gap.below)} -> ${fmt(s.gap.above)}  ` +
          `(${s.gap.count.toLocaleString()} above, ${(s.gap.share * 100).toFixed(2)}% of traffic)`,
      );
    }

    const rateOnly = RATE_ONLY[s.code];
    if (rateOnly) {
      out.push(
        `  fired on ${d.nonZero.toLocaleString()} of ${d.n.toLocaleString()} ` +
          `(${((d.nonZero / d.n) * 100).toFixed(2)}%) — ${rateOnly}`,
      );
    } else {
      const option = optionFor(s.code, s.mode);
      out.push(`  suggest ${option ? `${option}: ` : ''}${fmt(s.suggested)}`);
    }

    for (const caveat of s.caveats) {
      if (!shared.includes(caveat)) out.push(`    ! ${caveat}`);
    }
  }

  out.push(
    '',
    'These thresholds bound FALSE POSITIVES, not misses. They describe the shape',
    'of your traffic on the assumption that degeneration is rare in it. Nothing',
    'here shows a threshold catches anything — that needs labelled samples, which',
    'a log does not have. A `gap` line is the exception worth trusting: it is real',
    'separation observed in your own data.',
    '',
  );

  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    process.stdout.write(USAGE);
    return args.length === 0 ? 1 : 0;
  }

  const command = args[0] === 'calibrate' ? args.slice(1) : args;
  const asJson = command.includes('--json');

  let fpr = 0.001;
  const fprAt = command.indexOf('--fpr');
  if (fprAt !== -1) {
    const parsed = Number(command[fprAt + 1]);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      process.stderr.write('--fpr expects a rate between 0 and 1, e.g. 0.001\n');
      return 1;
    }
    fpr = parsed;
  }

  const file = command.find((arg, i) => !arg.startsWith('--') && command[i - 1] !== '--fpr');

  let text: string;
  try {
    text = file ? readFileSync(file, 'utf8') : await readStdin();
  } catch (error) {
    process.stderr.write(`Could not read ${file ?? 'stdin'}: ${(error as Error).message}\n`);
    return 1;
  }

  return report(text, fpr, asJson);
}

/*
 * No self-invocation check lives here on purpose.
 *
 * There was one, and it sniffed `process.argv[1]` to decide whether it was
 * being run rather than imported. Through npm's bin symlink that path is
 * `node_modules/.bin/llm-output-guard` -- no extension, no `dist/cli` -- so
 * the check said "imported", `main` never ran, and the CLI printed nothing
 * and exited 0. It worked every way it was tested except the only way users
 * invoke it.
 *
 * The executable is `bin.ts`, which does nothing but call `main`. This file
 * stays a plain module, so there is no condition left to get wrong.
 */
