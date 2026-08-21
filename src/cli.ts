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
import { checkOutput } from './check.js';
import { presets } from './presets.js';
import type { CheckOptions, ReasonCode, TokenMode, Verdict } from './types.js';

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


/* ------------------------------------------------------------------------- *
 * `check` -- score responses you already have.
 *
 * This exists because `calibrate` asks for a week of logged scores and nothing
 * in the package produced them. The loop had a missing first half: you could
 * derive thresholds from scores, and you could get scores at runtime through
 * `onVerdict`, but there was no way to score a directory of responses you had
 * already captured.
 *
 *   llm-output-guard check reply.txt
 *   llm-output-guard check logs/*.txt --json > scores.jsonl
 *   cat responses.jsonl | llm-output-guard check --jsonl --json | \
 *     llm-output-guard calibrate --fpr 0.001
 *
 * The exit code is the other half of the point: 1 when anything was judged
 * degenerate makes this an assertion you can put in CI or an eval suite.
 * ------------------------------------------------------------------------- */

/** Fields a logged response is plausibly stored under, in order of preference. */
const TEXT_FIELDS = ['text', 'output', 'content', 'response', 'completion', 'answer'];

/**
 * Dig the response text out of a logged line.
 *
 * Deliberately liberal about shape, for the same reason `extractScores` is: the
 * whole point is to accept whatever you already log rather than making you
 * reshape it first, because a step you have to prepare for is one you do not
 * run. A bare string, a record with an obvious field, and a raw provider
 * envelope all work.
 *
 * Returns null rather than guessing when nothing looks like a response. The
 * caller counts those and says so, so a whole file of unrecognised lines
 * reports as unrecognised instead of as healthy.
 */
export function extractText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;

  for (const field of TEXT_FIELDS) {
    const found = record[field];
    if (typeof found === 'string' && found.length > 0) return found;
  }

  /*
   * Raw provider envelopes, because logging the whole response is the laziest
   * and therefore commonest thing to do. Only the text is read: a logged
   * tool-call turn has no assistant text and is reported as unrecognised,
   * which is right -- scoring its empty string would put an `EMPTY: 1` spike
   * into a calibration run that describes the agent's tool use.
   */
  const openai = (record.choices as Array<{ message?: { content?: unknown } }> | undefined)
    ?.map((choice) => choice?.message?.content)
    .filter((c): c is string => typeof c === 'string')
    .join('');
  if (openai) return openai;

  const anthropic = (record.content as Array<{ type?: unknown; text?: unknown }> | undefined)
    ?.filter((block) => block?.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('');
  if (anthropic) return anthropic;

  // One level down, for a verdict or response buried in a wider log record.
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') {
      const found = extractText(nested);
      if (found) return found;
    }
  }
  return null;
}

interface CheckedItem {
  label: string;
  verdict: Verdict;
}

/** One line of human-readable output per response. */
function describe(item: CheckedItem): string {
  const { label, verdict } = item;
  if (verdict.ok) return `  ok    ${label}`;
  const detail = verdict.reasons
    .map((r) => `${r.code}=${r.score.toFixed(3)}>${r.threshold}`)
    .join(' ');
  return `  FAIL  ${label}\n          ${detail}`;
}

function runCheck(args: string[]): Promise<number> | number {
  const asJson = args.includes('--json');
  const asJsonl = args.includes('--jsonl');
  const quiet = args.includes('--quiet');

  let preset: CheckOptions = presets.chat;
  let presetName = 'chat';
  const presetAt = args.indexOf('--preset');
  if (presetAt !== -1) {
    const name = args[presetAt + 1];
    if (!name || !Object.hasOwn(presets, name)) {
      process.stderr.write(
        `--preset expects one of: ${Object.keys(presets).join(', ')}\n`,
      );
      return 2;
    }
    preset = presets[name as keyof typeof presets];
    presetName = name;
  }

  const files = args.filter(
    (arg, i) => !arg.startsWith('--') && args[i - 1] !== '--preset',
  );

  return (async () => {
    /*
     * Each source becomes one or more labelled texts. A file read as raw text
     * is one response; under `--jsonl` every non-blank line is one.
     */
    const items: Array<{ label: string; text: string }> = [];
    let unrecognised = 0;

    const ingest = (label: string, raw: string): void => {
      if (!asJsonl) {
        items.push({ label, text: raw });
        return;
      }
      let lineNo = 0;
      for (const line of raw.split('\n')) {
        lineNo += 1;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          unrecognised += 1;
          continue;
        }
        const text = extractText(parsed);
        if (text === null) unrecognised += 1;
        else items.push({ label: `${label}:${lineNo}`, text });
      }
    };

    try {
      if (files.length === 0) ingest('stdin', await readStdin());
      else for (const file of files) ingest(file, readFileSync(file, 'utf8'));
    } catch (error) {
      process.stderr.write(`Could not read input: ${(error as Error).message}\n`);
      return 2;
    }

    if (items.length === 0) {
      process.stderr.write(
        unrecognised > 0
          ? `No response text found in ${unrecognised} line(s). See --help for the shapes read.\n`
          : 'No input. Pass a file, or pipe text on stdin.\n',
      );
      return 2;
    }

    const checked: CheckedItem[] = items.map(({ label, text }) => ({
      label,
      verdict: checkOutput(text, preset),
    }));

    if (asJson) {
      for (const { label, verdict } of checked) {
        process.stdout.write(JSON.stringify({ label, ...verdict }) + '\n');
      }
    } else if (!quiet) {
      for (const item of checked) process.stdout.write(describe(item) + '\n');
      const failed = checked.filter((c) => !c.verdict.ok).length;
      process.stdout.write(
        `\n  ${checked.length} checked under presets.${presetName}, ` +
          `${failed} degenerate` +
          (unrecognised > 0 ? `, ${unrecognised} line(s) unrecognised` : '') +
          '\n',
      );
    }

    return checked.some((c) => !c.verdict.ok) ? 1 : 0;
  })();
}

const USAGE = `
llm-output-guard — two commands, and they compose

  check       score responses you already have
  calibrate   derive thresholds from scored responses

llm-output-guard check — score responses you already have

  npx llm-output-guard check reply.txt
  npx llm-output-guard check logs/*.txt --json > scores.jsonl
  cat responses.jsonl | npx llm-output-guard check --jsonl --json

Options
  --preset <name>  chat | strictJson | longForm | lenient (default chat)
  --jsonl          read input as JSONL, one logged response per line
  --json           emit a verdict per response as JSONL, for calibrate
  --quiet          no per-response output; the exit code is the answer

Exit code is the point in CI: 0 when everything passed, 1 when anything was
judged degenerate, 2 when the input could not be read.

Under --jsonl the response text is dug out of each line, liberally. A bare
string, an obvious field, or a raw provider envelope all work:

  "the response text"
  {"text":"the response text"}
  {"choices":[{"message":{"content":"the response text"}}]}
  {"content":[{"type":"text","text":"the response text"}]}

The two commands are halves of one loop:

  llm-output-guard check logs/*.txt --json | llm-output-guard calibrate

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

  /*
   * `check` is opt-in by name; everything else still means `calibrate`, with or
   * without the word. That default is load-bearing rather than lazy: the
   * documented invocation since 0.4 has been `llm-output-guard scores.jsonl`,
   * and requiring the subcommand now would break it for every reader of an
   * older README.
   */
  if (args[0] === 'check') return runCheck(args.slice(1));

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
