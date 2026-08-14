import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { Window } from 'happy-dom';

/**
 * The playground, executed rather than inspected.
 *
 * This file exists because of a bug that every static check passed. The page
 * inlined `dist/index.js`, which is code-split: its first line is
 * `export { checkOutput, ... } from './chunk-XHP4LSIH.js'`. Inlined into a page
 * with no chunk beside it, the browser failed to load the module and rendered an
 * empty shell -- no specimens, no meters, no verdict.
 *
 * Nothing caught it. The HTML contained no placeholder, the module parsed under
 * `node --check`, there were no external URLs, and the theme audit was clean. It
 * was valid, self-consistent, and completely inert. The only check that
 * distinguishes a working page from that one is running it.
 *
 * So these tests execute the real module against a real DOM and assert the page
 * populated. Cheap insurance against a class of failure that is invisible to
 * every cheaper check.
 */

const PAGE = new URL('../docs/index.html', import.meta.url).pathname;

/*
 * Structural types rather than the global DOM ones. `tsconfig.json` sets
 * `lib: ["ES2022"]` with no DOM on purpose -- that is what keeps `src/` from
 * quietly depending on a browser global -- and widening it project-wide for one
 * test file would spend a real guarantee on a convenience.
 */
interface El {
  textContent: string | null;
  className: string;
  value: string;
  style: { width: string; left: string };
  click(): void;
}
interface Doc {
  body: { innerHTML: string };
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): El[];
}

let html: string;
let doc: Doc;

/** Runs the page's inline module against a fresh DOM and returns the document. */
function render(): Doc {
  const window = new Window({ url: 'https://example.test/' });
  const document = window.document;

  document.body.innerHTML = html.replace(/<script type="module">[\s\S]*?<\/script>/, '');

  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  if (!code) throw new Error('no module script found in the page');

  /*
   * The module has had its import/export statements bundled away, so it is
   * plain script text by this point and can be invoked directly. If that ever
   * stops being true this throws, which is the correct outcome -- a page with a
   * live module dependency is the exact bug being guarded against.
   */
  new Function('window', 'document', code)(window, document);

  return document as unknown as Doc;
}

beforeAll(() => {
  if (!existsSync(PAGE)) {
    throw new Error('docs/index.html is missing — run `npm run playground` first');
  }
  html = readFileSync(PAGE, 'utf8');
  doc = render();
});

describe('the playground is self-contained', () => {
  /*
   * The specific failure. `export ... from './chunk.js'` is a module dependency
   * exactly as much as `import` is, and grepping only for `import` is what let
   * it through the first time.
   */
  it('carries no module dependency on a file that was never copied', () => {
    const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] ?? '';
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\bfrom\s*['"]\.\.?\//);
    expect(code).not.toMatch(/chunk-[A-Z0-9]+\.js/i);
  });

  it('requests nothing over the network', () => {
    // Navigation links are fine; a fetched resource is not.
    const resources = html.match(/(?:src|href)\s*=\s*"(?!#)[^"]*"/g) ?? [];
    const external = resources.filter((r) => !/^href\s*=\s*"https:\/\/(github|www\.npmjs)\.com/.test(r));
    expect(external).toEqual([]);
  });

  /*
   * The committed page is what GitHub Pages serves, and CI runs `npm test`
   * before any build -- so these tests read the file in the repo rather than a
   * fresh one. That is the right target, but it means a stale page would pass
   * every assertion above. The stamped version is the cheapest thing that goes
   * out of date, and checking it needs no build.
   */
  it('is not stale relative to the released version', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'),
    );
    expect(html, 'run `npm run playground` — docs/index.html is behind package.json').toContain(
      `v${pkg.version}`,
    );
  });
});

describe('the playground actually runs', () => {
  it('renders both specimen groups', () => {
    expect(doc.querySelectorAll('#chips-bad .chip').length).toBeGreaterThan(0);
    expect(doc.querySelectorAll('#chips-good .chip').length).toBeGreaterThan(0);
  });

  it('renders every preset control', () => {
    const labels = [...doc.querySelectorAll('#presets .seg')].map((n) => n.textContent);
    expect(labels).toEqual(['chat', 'strictJson', 'longForm', 'lenient']);
  });

  it('renders a meter for all eight detectors', () => {
    const codes = [...doc.querySelectorAll('.meter .code')].map((n) =>
      (n.textContent ?? '').replace(/\s*\[.*$/, '').trim(),
    );
    expect(codes).toEqual([
      'EMPTY', 'TOO_SHORT', 'REPETITION', 'TAIL_LOOP',
      'LOW_ENTROPY', 'TRUNCATED', 'INVALID_JSON', 'LANG_MISMATCH',
    ]);
  });

  /* Opening on a loop is the point -- an empty box demonstrates nothing. */
  it('opens on a degenerate specimen, already judged', () => {
    const input = doc.querySelector('#input');
    expect(input?.value.length ?? 0).toBeGreaterThan(200);

    expect(doc.querySelector('#verdict')?.className).toContain('bad');
    expect(doc.querySelector('#verdict-codes')?.textContent).toContain('REPETITION');
    expect(doc.querySelector('#charcount')?.textContent).not.toBe('0 chars');
  });

  it('fills a meter and marks the ones that crossed', () => {
    const over = [...doc.querySelectorAll('.fill.over')];
    expect(over.length).toBeGreaterThan(0);
    expect(over[0].style.width).toMatch(/^\d/);

    const ticks = [...doc.querySelectorAll('.tick')];
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0].style.left).toMatch(/%$/);
  });

  it('shows the note for the opening specimen', () => {
    expect((doc.querySelector('#note')?.textContent ?? '').length).toBeGreaterThan(20);
  });
});

describe('the controls change the readout', () => {
  it('re-judges when a healthy trap is selected', () => {
    const fresh = render();
    expect(fresh.querySelector('#verdict')?.className).toContain('bad');

    fresh.querySelector('#chips-good .chip')?.click();

    // A trap is healthy under the preset it is written for, and picking one
    // selects that preset -- so the verdict must flip.
    expect(fresh.querySelector('#verdict')?.className).toContain('ok');
  });

  it('reports the preset in the generated snippet', () => {
    expect(doc.querySelector('#snippet')?.textContent).toContain('presets.');
    expect(doc.querySelector('#snippet')?.textContent).toContain('checkOutput');
  });
});
