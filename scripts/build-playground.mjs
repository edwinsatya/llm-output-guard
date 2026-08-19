/**
 * Builds the playground into a single self-contained HTML file: docs/index.html.
 *
 *   npm run playground
 *
 * The library is inlined rather than fetched from a CDN, so the page has no
 * network dependency and runs the *real* detectors -- the numbers on screen are
 * the numbers the package produces, not a reimplementation that can drift.
 * Wired into the release flow for that reason: regenerate on every version and
 * the demo cannot fall behind the code it is demonstrating.
 *
 * Specimens are the project's own fixtures, read from test/fixtures at build
 * time rather than copied, so a fixture edited there is a specimen changed here.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { checkOutput, presets } from '../dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}docs/index.html`;

const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));

/**
 * The specimens, and the preset each one is written for.
 *
 * That second part is load-bearing. A preset is a contract for a task, not a
 * strictness dial: presets.chat leaves truncation and JSON off entirely, so a
 * truncated specimen judged by it is not being missed -- it is not being asked
 * about. Pinning each specimen to a preset under which its label holds is what
 * keeps the page honest; the page then says so when you switch away.
 */
const PICK = {
  degenerate: [
    'repetition-word-stutter', 'repetition-clause-loop', 'tail-loop-after-good-start',
    'cjk-tail-loop-zh-nopunct', 'low-entropy-charspam', 'truncated-mid-sentence',
    'empty-json-braces', 'invalid-json-prose-wrapper',
  ],
  healthy: [
    'markdown-table', 'list-repeated-prefix', 'prose-en-with-refrain',
    'code-block-typescript', 'prose-zh-poem-refrain', 'prose-zh-repeated-prefix-steps',
    'prose-en-technical-explanation', 'json-fenced-valid',
  ],
};

const PRESET_ORDER = ['chat', 'strictJson', 'longForm', 'lenient'];

function loadFixtures() {
  const result = { degenerate: [], healthy: [] };
  for (const [kind, ids] of Object.entries(PICK)) {
    const dir = `${root}test/fixtures/${kind === 'degenerate' ? 'bad' : 'good'}`;
    for (const id of ids) {
      const f = JSON.parse(readFileSync(`${dir}/${id}.json`, 'utf8'));
      const wantFail = kind === 'degenerate';
      // A JSON specimen under presets.chat never exercises the JSON contract.
      const preset = /json/.test(id)
        ? 'strictJson'
        : PRESET_ORDER.find((p) => checkOutput(f.text, presets[p]).ok !== wantFail) ?? 'chat';

      if (checkOutput(f.text, presets[preset]).ok === wantFail) {
        throw new Error(`fixture ${id} does not behave as labelled under any preset`);
      }
      result[kind].push({ id: f.id ?? id, note: f.note ?? '', text: f.text, preset });
    }
  }
  return result;
}

const fixtures = loadFixtures();

/**
 * The library, bundled to a genuinely single file.
 *
 * Emphatically not `dist/index.js` with its export statements stripped. That
 * build is code-split: its first line is `export { checkOutput, ... } from
 * './chunk-XHP4LSIH.js'`, so inlining it produces a page that asks the browser
 * for a chunk that was never copied, fails to load the module, and renders an
 * empty shell. It also fails *silently* -- the file parses fine, and every
 * static check short of running it passes.
 *
 * So the bundling is done here, from source, with splitting off. The chunk name
 * carries a content hash and changes on any build, which is one more reason not
 * to depend on its shape.
 */
async function bundleLibrary() {
  const result = await esbuild.build({
    entryPoints: [`${root}src/index.ts`],
    bundle: true,
    splitting: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    write: false,
    legalComments: 'none',
  });
  // The bundle ends in one export statement; inside an inline module the
  // declarations are already in scope and nothing imports this.
  return result.outputFiles[0].text.replace(/^export \{[\s\S]*?\};?\s*$/m, '').trim();
}

const lib = await bundleLibrary();

if (!/function checkOutput/.test(lib) || !/presets\s*=/.test(lib)) {
  throw new Error('bundle is missing checkOutput or presets — the page would render empty');
}

const page = String.raw`<title>Degeneracy Bench</title>
<style>
  :root {
    --ground: #f4f7f9;
    --surface: #ffffff;
    --surface-2: #eef2f5;
    --ink: #121820;
    --muted: #57626e;
    --line: #dbe2e8;
    --accent: #10617a;
    --accent-soft: #d6e7ed;
    --on-accent: #ffffff;
    --pass: #2a7355;
    --fail: #ad4034;
    --warn: #976c15;
    --shadow: 0 1px 2px rgba(18, 24, 32, .06), 0 8px 24px -12px rgba(18, 24, 32, .18);
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #0e1319;
      --surface: #151b23;
      --surface-2: #1b232c;
      --ink: #e0e7ee;
      --muted: #8b96a3;
      --line: #242d38;
      --accent: #5cb3cf;
      --accent-soft: #16323d;
      --on-accent: #0e1319;
      --pass: #5fbb90;
      --fail: #e08074;
      --warn: #d3a94a;
      --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px -12px rgba(0, 0, 0, .7);
    }
  }
  :root[data-theme="dark"] {
    --ground: #0e1319;
    --surface: #151b23;
    --surface-2: #1b232c;
    --ink: #e0e7ee;
    --muted: #8b96a3;
    --line: #242d38;
    --accent: #5cb3cf;
    --accent-soft: #16323d;
    --on-accent: #0e1319;
    --pass: #5fbb90;
    --fail: #e08074;
    --warn: #d3a94a;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px -12px rgba(0, 0, 0, .7);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 40px 24px 72px; }

  /* ---- header ---------------------------------------------------------- */
  header { display: flex; flex-direction: column; gap: 14px; margin-bottom: 34px; }
  .eyebrow {
    font-family: var(--mono); font-size: 11px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--accent); font-weight: 600;
  }
  h1 {
    margin: 0; font-size: clamp(28px, 4.2vw, 40px); line-height: 1.1;
    letter-spacing: -.022em; font-weight: 640; text-wrap: balance;
  }
  .lede { margin: 0; max-width: 62ch; color: var(--muted); font-size: 16.5px; }
  .lede strong { color: var(--ink); font-weight: 600; }
  .install {
    font-family: var(--mono); font-size: 13px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 7px; padding: 9px 13px;
    align-self: flex-start; color: var(--ink); box-shadow: var(--shadow);
  }
  .install span { color: var(--muted); user-select: none; }

  /* ---- layout ---------------------------------------------------------- */
  .bench { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 22px; }
  @media (max-width: 900px) { .bench { grid-template-columns: minmax(0, 1fr); } }

  .panel {
    background: var(--surface); border: 1px solid var(--line); border-radius: 11px;
    box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden;
  }
  .panel-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    padding: 13px 17px; border-bottom: 1px solid var(--line); background: var(--surface-2);
  }
  .panel-title {
    font-family: var(--mono); font-size: 11px; letter-spacing: .13em;
    text-transform: uppercase; color: var(--muted); font-weight: 600;
  }
  .panel-body { padding: 17px; display: flex; flex-direction: column; gap: 15px; }

  /* ---- specimen -------------------------------------------------------- */
  .group-label {
    font-family: var(--mono); font-size: 10.5px; letter-spacing: .11em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 8px; font-weight: 600;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-family: var(--mono); font-size: 11.5px; padding: 5px 10px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--surface); color: var(--muted);
    cursor: pointer; transition: border-color .13s, color .13s, background .13s;
  }
  .chip:hover { border-color: var(--accent); color: var(--accent); }
  .chip[aria-pressed="true"] {
    background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600;
  }
  .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  textarea {
    width: 100%; min-height: 232px; resize: vertical; padding: 13px;
    font-family: var(--mono); font-size: 12.5px; line-height: 1.62;
    background: var(--ground); color: var(--ink);
    border: 1px solid var(--line); border-radius: 8px;
  }
  textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }

  .note {
    font-size: 13px; color: var(--muted); border-left: 2px solid var(--accent);
    padding-left: 11px; min-height: 1.55em;
  }
  .note b { color: var(--ink); font-weight: 600; }

  /* ---- verdict --------------------------------------------------------- */
  .verdict {
    display: flex; align-items: center; gap: 11px; padding: 13px 15px;
    border-radius: 9px; border: 1px solid; font-family: var(--mono);
  }
  .verdict.ok { background: color-mix(in srgb, var(--pass) 9%, transparent); border-color: color-mix(in srgb, var(--pass) 38%, transparent); }
  .verdict.bad { background: color-mix(in srgb, var(--fail) 9%, transparent); border-color: color-mix(in srgb, var(--fail) 38%, transparent); }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .verdict.ok .dot { background: var(--pass); }
  .verdict.bad .dot { background: var(--fail); }
  .verdict-text { font-size: 13.5px; font-weight: 600; }
  .verdict.ok .verdict-text { color: var(--pass); }
  .verdict.bad .verdict-text { color: var(--fail); }
  .verdict-codes { margin-left: auto; font-size: 11.5px; color: var(--muted); text-align: right; }

  /* ---- meters ---------------------------------------------------------- */
  .meters { display: flex; flex-direction: column; gap: 2px; }
  .meter {
    display: grid; grid-template-columns: 116px minmax(0, 1fr) 52px;
    align-items: center; gap: 11px; padding: 7px 0;
  }
  .meter.off { opacity: .38; }
  .code {
    font-family: var(--mono); font-size: 11px; letter-spacing: .04em;
    font-weight: 600; color: var(--ink);
  }
  .code .mode { color: var(--muted); font-weight: 400; }
  .track {
    position: relative; height: 7px; border-radius: 4px;
    background: var(--surface-2); border: 1px solid var(--line); overflow: visible;
  }
  .fill {
    position: absolute; inset: 0 auto 0 0; border-radius: 3px;
    background: var(--pass); transition: width .28s cubic-bezier(.4, 0, .2, 1), background .18s;
  }
  .fill.over { background: var(--fail); }
  .tick {
    position: absolute; top: -4px; bottom: -4px; width: 2px; border-radius: 1px;
    background: var(--ink); opacity: .5; transition: left .28s cubic-bezier(.4, 0, .2, 1);
  }
  .val {
    font-family: var(--mono); font-size: 12px; text-align: right;
    font-variant-numeric: tabular-nums; color: var(--muted);
  }
  .val.over { color: var(--fail); font-weight: 600; }
  @media (prefers-reduced-motion: reduce) { .fill, .tick { transition: none; } }

  .legend {
    display: flex; gap: 16px; flex-wrap: wrap; font-family: var(--mono);
    font-size: 10.5px; color: var(--muted); padding-top: 3px;
  }
  .legend i { display: inline-block; width: 16px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
  .legend .k-tick { width: 2px; height: 11px; background: var(--ink); opacity: .5; }

  /* ---- controls -------------------------------------------------------- */
  .presets { display: flex; gap: 5px; flex-wrap: wrap; }
  .seg {
    font-family: var(--mono); font-size: 11.5px; padding: 6px 12px; cursor: pointer;
    border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 7px;
    transition: border-color .13s, color .13s, background .13s;
  }
  .seg:hover { border-color: var(--accent); color: var(--accent); }
  /* One declaration, taking its contrast from a token that flips with the
     theme. Chasing this with extra [data-theme] rules is how a colour ends up
     defined only inside one branch and unset in the un-stamped default. */
  .seg[aria-pressed="true"] {
    background: var(--accent); border-color: var(--accent);
    color: var(--on-accent); font-weight: 600;
  }
  .seg:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  pre.snippet {
    margin: 0; padding: 13px; background: var(--ground); border: 1px solid var(--line);
    border-radius: 8px; font-family: var(--mono); font-size: 12px; line-height: 1.6;
    overflow-x: auto; color: var(--ink);
  }
  .snippet .k { color: var(--accent); }
  .snippet .s { color: var(--pass); }
  .snippet .c { color: var(--muted); }

  /* ---- explainer ------------------------------------------------------- */
  .explain { margin-top: 40px; display: grid; grid-template-columns: repeat(auto-fit, minmax(248px, 1fr)); gap: 18px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 11px; padding: 17px; box-shadow: var(--shadow); }
  .card h3 { margin: 0 0 7px; font-size: 14px; font-weight: 640; letter-spacing: -.006em; }
  .card p { margin: 0; font-size: 13.5px; color: var(--muted); }
  .card code { font-family: var(--mono); font-size: 12px; color: var(--ink); }

  footer {
    margin-top: 38px; padding-top: 18px; border-top: 1px solid var(--line);
    display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline;
    font-size: 13px; color: var(--muted);
  }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  footer a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  .ver { font-family: var(--mono); font-size: 11.5px; margin-left: auto; }
</style>

<div class="wrap">
  <header>
    <div class="eyebrow">llm-output-guard &middot; live</div>
    <h1>Degeneracy Bench</h1>
    <p class="lede">
      Every detector in the package, running <strong>in your browser</strong> on whatever you
      paste. No API key, no request, no server &mdash; the library is zero-dependency and
      synchronous, so this page runs the real thing. The numbers below are what
      <code>checkOutput</code> returns.
    </p>
    <div class="install"><span>$</span> npm i llm-output-guard</div>
  </header>

  <div class="bench">
    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">Specimen</span>
        <span class="panel-title" id="charcount">0 chars</span>
      </div>
      <div class="panel-body">
        <div>
          <div class="group-label">Degenerate &mdash; should be caught</div>
          <div class="chips" id="chips-bad"></div>
        </div>
        <div>
          <div class="group-label">Healthy traps &mdash; should <em>not</em> be caught</div>
          <div class="chips" id="chips-good"></div>
        </div>
        <textarea id="input" spellcheck="false" aria-label="Model output to check"></textarea>
        <p class="note" id="note"></p>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <span class="panel-title">Readout</span>
        <div class="presets" id="presets"></div>
      </div>
      <div class="panel-body">
        <div class="verdict ok" id="verdict">
          <span class="dot"></span>
          <span class="verdict-text" id="verdict-text">ok</span>
          <span class="verdict-codes" id="verdict-codes"></span>
        </div>
        <div class="meters" id="meters"></div>
        <div class="legend">
          <span><i class="k-tick"></i>threshold</span>
          <span><i style="background: var(--pass)"></i>under</span>
          <span><i style="background: var(--fail)"></i>over &rarr; fails</span>
        </div>
        <pre class="snippet" id="snippet"></pre>
      </div>
    </section>
  </div>

  <div class="explain">
    <div class="card">
      <h3>Scores, not booleans</h3>
      <p>Each detector returns 0&ndash;1 and you pick the line. The tick on each track is the
        threshold for the selected preset &mdash; switch presets and watch the ticks move while
        the scores stay put.</p>
    </div>
    <div class="card">
      <h3>Every detector runs</h3>
      <p>Nothing short-circuits on the first failure, so a verdict shows the whole picture
        rather than whichever check happened to be ordered first. Passing scores are reported
        too &mdash; those are what you feed to your metrics.</p>
    </div>
    <div class="card">
      <h3>False positives cost more</h3>
      <p>A miss is annoying; discarding a healthy response and retrying against a slower
        provider is worse. That is why the corpus carries traps &mdash; markdown tables, repeated
        list prefixes, rhetorical refrains &mdash; that a naive detector flags.</p>
    </div>
    <div class="card">
      <h3>Word and character modes</h3>
      <p>Chinese, Japanese and Thai put no spaces between words, so a whole clause is one
        token and word n&#8209;grams measure nothing. <code>TAIL_LOOP</code> switches to
        characters and reads its own threshold &mdash; the label shows which ran.</p>
    </div>
  </div>

  <footer>
    <a href="https://github.com/edwinsatya/llm-output-guard">GitHub</a>
    <a href="https://www.npmjs.com/package/llm-output-guard">npm</a>
    <span>Specimens are the project&rsquo;s own test fixtures.</span>
    <span class="ver">v__VERSION__</span>
  </footer>
</div>

<script type="module">
__LIB__

const FIXTURES = __FIXTURES__;

/* Thresholds per code. A verdict carries one only for detectors that failed, so
   the passing ones are derived from the same options checkOutput was given --
   otherwise the tick would vanish on exactly the tracks that are behaving. */
const EMPTY_T = 0.5;
function thresholdFor(code, opts, mode) {
  switch (code) {
    case 'EMPTY': return EMPTY_T;
    case 'TOO_SHORT': return 0;
    case 'REPETITION': return opts.maxRepetition ?? null;
    case 'TAIL_LOOP': return (mode === 'char' ? opts.maxCharTailLoop : opts.maxTailLoop) ?? null;
    case 'LOW_ENTROPY': return opts.maxCompressibility ?? null;
    case 'TRUNCATED': return opts.maxTruncation ?? 0.75;
    case 'INVALID_JSON': return 0;
    case 'SCRIPT_MISMATCH': return opts.maxScriptMismatch ?? 0.5;
    case 'LANG_MISMATCH': return opts.maxLangMismatch ?? 0.6;
    default: return null;
  }
}

const ORDER = ['EMPTY', 'TOO_SHORT', 'REPETITION', 'TAIL_LOOP', 'LOW_ENTROPY', 'TRUNCATED', 'INVALID_JSON', 'SCRIPT_MISMATCH', 'LANG_MISMATCH'];
const PRESETS = ['chat', 'strictJson', 'longForm', 'lenient'];

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let activePreset = 'chat';
let activeChip = null;

function buildChips(containerId, list, kind) {
  const box = $(containerId);
  list.forEach((f) => {
    const b = el('button', 'chip', f.id);
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      $('input').value = f.text;
      activeChip = { ...f, kind };
      document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      /* Each specimen carries the preset it was written for. A preset is a
         contract for a task, not a strictness dial: presets.chat leaves
         truncation and JSON off entirely, so a truncated specimen judged by it
         is not being missed -- it is not being asked about. Switching here keeps
         the labels honest; switching back by hand is where that lesson lands. */
      setPreset(f.preset || 'chat');
      run();
    });
    box.appendChild(b);
  });
}

function setPreset(name) {
  activePreset = name;
  document.querySelectorAll('.seg').forEach((s) => {
    s.setAttribute('aria-pressed', String(s.textContent === name));
  });
}

function buildPresets() {
  const box = $('presets');
  PRESETS.forEach((name) => {
    const b = el('button', 'seg', name);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(name === activePreset));
    b.addEventListener('click', () => {
      setPreset(name);
      run();
    });
    box.appendChild(b);
  });
}

function run() {
  const text = $('input').value;
  const opts = presets[activePreset];
  const verdict = checkOutput(text, opts);

  $('charcount').textContent = text.length.toLocaleString() + ' chars';

  /* ---- verdict banner ---- */
  const v = $('verdict');
  v.className = 'verdict ' + (verdict.ok ? 'ok' : 'bad');
  $('verdict-text').textContent = verdict.ok ? 'ok — nothing crossed its threshold' : 'degenerate';
  $('verdict-codes').textContent = verdict.ok
    ? 'presets.' + activePreset
    : verdict.reasons.map((r) => r.code).join('  ');

  /* ---- meters ---- */
  const box = $('meters');
  box.textContent = '';
  const failing = new Set(verdict.reasons.map((r) => r.code));

  ORDER.forEach((code) => {
    const has = Object.prototype.hasOwnProperty.call(verdict.scores, code);
    const score = has ? verdict.scores[code] : 0;
    const mode = verdict.modes ? verdict.modes[code] : undefined;
    const t = thresholdFor(code, opts, mode);
    const over = failing.has(code);

    const row = el('div', 'meter' + (has ? '' : ' off'));

    const label = el('div', 'code');
    label.textContent = code;
    if (mode) {
      const m = el('span', 'mode', ' [' + mode + ']');
      label.appendChild(m);
    }

    const track = el('div', 'track');
    const fill = el('div', 'fill' + (over ? ' over' : ''));
    fill.style.width = Math.max(0, Math.min(1, score)) * 100 + '%';
    track.appendChild(fill);
    if (has && t != null && t > 0 && t < 1) {
      const tick = el('div', 'tick');
      tick.style.left = t * 100 + '%';
      tick.title = 'threshold ' + t;
      track.appendChild(tick);
    }

    const val = el('div', 'val' + (over ? ' over' : ''));
    val.textContent = has ? score.toFixed(3) : '—';

    row.append(label, track, val);
    box.appendChild(row);
  });

  /* ---- note ---- */
  const note = $('note');
  note.textContent = '';
  if (activeChip && activeChip.note) {
    const wantFail = activeChip.kind === 'bad';
    const asLabelled = verdict.ok !== wantFail;
    const strong = el('b', null, wantFail ? 'Degenerate. ' : 'Healthy. ');
    note.append(strong, document.createTextNode(activeChip.note.replace(/^TRAP:\s*/i, '')));

    /* A specimen judged by the wrong preset is not a miss -- it is a question
       that preset does not ask. Saying so is the difference between the page
       teaching the model and the page looking broken. */
    if (!asLabelled) {
      const why = el('span', null,
        wantFail
          ? '  Not caught here: presets.' + activePreset + ' does not enable the detector this one trips. Try presets.' + activeChip.preset + '.'
          : '  Flagged here: presets.' + activePreset + ' asks for something this specimen is not. Try presets.' + activeChip.preset + '.');
      why.style.color = 'var(--warn)';
      note.appendChild(why);
    }
  } else {
    note.textContent = 'Pick a specimen above, or paste your own model output.';
  }

  /* ---- snippet ---- */
  $('snippet').innerHTML =
    '<span class="k">import</span> { checkOutput, presets } <span class="k">from</span> <span class="s">&#39;llm-output-guard&#39;</span>;\n' +
    '\n' +
    '<span class="k">const</span> verdict = checkOutput(text, presets.' + activePreset + ');\n' +
    (verdict.ok
      ? '<span class="c">// verdict.ok === true — use the response</span>'
      : '<span class="c">// verdict.ok === false — ' + verdict.reasons.map((r) => r.code).join(', ') + '</span>');
}

buildChips('chips-bad', FIXTURES.degenerate, 'bad');
buildChips('chips-good', FIXTURES.healthy, 'good');
buildPresets();
$('input').addEventListener('input', () => { activeChip = null;
  document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
  run();
});

/* Open on a loop, because the package's whole reason for existing is visible in
   one glance there rather than on an empty box. */
const first = FIXTURES.degenerate[0];
$('input').value = first.text;
activeChip = { ...first, kind: 'bad' };
document.querySelector('#chips-bad .chip').setAttribute('aria-pressed', 'true');
run();
</script>
`;

mkdirSync(`${root}docs`, { recursive: true });
writeFileSync(
  out,
  page
    .replace('__LIB__', () => lib)
    .replace('__FIXTURES__', () => JSON.stringify(fixtures))
    .replace('__VERSION__', pkg.version),
);

console.log(`wrote ${out} (${(readFileSync(out, 'utf8').length / 1024).toFixed(1)} KB)`);
