/**
 * Proves the optional peer ranges in package.json are ranges we have actually
 * run against, rather than ones we assumed.
 *
 * For each version given, this installs the *packed* tarball -- so the subpath
 * is resolved through the published `exports` map and the emitted `.d.ts`,
 * exactly as a user gets it -- alongside that peer version, then:
 *
 *   1. typechecks the documented usage,
 *   2. runs the adapter against that major's real shapes.
 *
 * Step 2 exists because step 1 is not enough. The range this replaced claimed
 * `ai >= 4`, and `ai@4` typechecks against the adapter fine: every field it
 * reads is optional, so a v1 result -- which carries `text`, not `content` --
 * satisfies the types while reading as the empty string. Healthy output came
 * back `EMPTY` and, on the default `'throw'`, failed every call. Types alone
 * would have kept saying that was supported.
 *
 *   node scripts/check-peers.mjs                 # every peer, declared ends
 *   node scripts/check-peers.mjs ai              # one peer, declared ends
 *   node scripts/check-peers.mjs openai 4 7      # one peer, explicit versions
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(
  execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
    cwd: root,
    encoding: 'utf8',
  }),
);

const AI_PROBE_TS = `
import { wrapLanguageModel } from 'ai';
import { outputGuard, type OutputGuardOptions } from 'llm-output-guard/ai-sdk';
import { presets, type Verdict } from 'llm-output-guard';

export const model = wrapLanguageModel({
  model: {} as never,
  middleware: outputGuard({ ...presets.chat, onDegenerate: 'abort' }),
});

const options: OutputGuardOptions = {
  ...presets.chat,
  onDegenerate: 'ignore',
  onVerdict: (verdict: Verdict, context: { streaming: boolean }) =>
    void [verdict.ok, context.streaming, verdict.modes],
};
export const guarded = wrapLanguageModel({ model: {} as never, middleware: outputGuard(options) });
`;

const AI_PROBE_MJS = `
import { outputGuard } from 'llm-output-guard/ai-sdk';
import assert from 'node:assert/strict';

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is at-most-once delivery, so a ' +
  'client reconnecting mid-game refetches state rather than replaying it.';
const LOOPING = 'Your strongest area is TypeScript. ' + 'You should add tests to this repo. '.repeat(60);

// v2 (ai@5) reports a bare string; v3/v4 (ai@6/7) an object. Both are claimed.
const FINISH = process.env.PEER_MAJOR === '5' ? 'stop' : { unified: 'stop', raw: 'stop' };
const generateOf = (text) => () =>
  Promise.resolve({ content: [{ type: 'text', text }], finishReason: FINISH, usage: {} });

const verdicts = [];
const guard = outputGuard({ onDegenerate: 'ignore', onVerdict: (v) => verdicts.push(v) });
await guard.wrapGenerate({ doGenerate: generateOf(HEALTHY) });
assert.ok(verdicts[0].ok, 'healthy generate was flagged: ' + JSON.stringify(verdicts[0].reasons));
await guard.wrapGenerate({ doGenerate: generateOf(LOOPING) });
assert.equal(verdicts[1].ok, false, 'a looping generate was not flagged');

const partsOf = (text) => {
  const parts = [{ type: 'text-start', id: '0' }];
  for (let i = 0; i < text.length; i += 16) {
    parts.push({ type: 'text-delta', id: '0', delta: text.slice(i, i + 16) });
  }
  parts.push({ type: 'text-end', id: '0' }, { type: 'finish', finishReason: FINISH, usage: {} });
  return parts;
};
const drain = async (text, options) => {
  const parts = partsOf(text);
  let asked = 0;
  const stream = new ReadableStream({
    pull(controller) {
      const next = parts.shift();
      if (!next) return controller.close();
      asked += 1;
      controller.enqueue(next);
    },
  });
  const result = await outputGuard(options).wrapStream({ doStream: () => Promise.resolve({ stream }) });
  let seen = '';
  for await (const part of result.stream) if (part.type === 'text-delta') seen += part.delta;
  return { seen, asked, total: partsOf(text).length };
};

const streamed = [];
const healthy = await drain(HEALTHY, { onDegenerate: 'ignore', onVerdict: (v) => streamed.push(v) });
assert.equal(healthy.seen, HEALTHY, 'a healthy stream was not forwarded intact');
assert.ok(streamed.at(-1).ok, 'healthy stream was flagged');
const looping = await drain(LOOPING, { onDegenerate: 'abort' });
assert.ok(looping.asked < looping.total, 'the looping stream ran to completion; nothing was saved');
console.log('    runtime ok -- looping stream cut at ' + looping.asked + '/' + looping.total + ' parts');
`;

const OPENAI_PROBE_TS = `
import OpenAI from 'openai';
import { withOutputGuard, type OutputGuardOptions } from 'llm-output-guard/openai';
import { presets, type Verdict } from 'llm-output-guard';

export const client = withOutputGuard(new OpenAI({ apiKey: 'x' }), {
  ...presets.chat,
  onDegenerate: 'abort',
});

const options: OutputGuardOptions = {
  ...presets.chat,
  onDegenerate: 'ignore',
  onVerdict: (verdict: Verdict, context: { streaming: boolean }) =>
    void [verdict.ok, context.streaming, verdict.modes],
};
export const guarded = withOutputGuard(new OpenAI({ apiKey: 'x' }), options);
`;

/**
 * Drives a real client over a mock transport, so cancellation is observed where
 * it matters: the response body. "The abort callback ran" would pass even if
 * the connection kept streaming tokens, which is the thing being claimed.
 */
const OPENAI_PROBE_MJS = `
import OpenAI from 'openai';
import { withOutputGuard } from 'llm-output-guard/openai';
import assert from 'node:assert/strict';

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is at-most-once delivery, so a ' +
  'client reconnecting mid-game refetches state rather than replaying it.';
const LOOPING = 'Your strongest area is TypeScript. ' + 'You should add tests to this repo. '.repeat(60);

function transport(text, finishReason = 'stop') {
  const pieces = [];
  for (let i = 0; i < text.length; i += 16) pieces.push(text.slice(i, i + 16));
  const state = { sent: 0, total: pieces.length + 1, cancelled: false };
  const sse = (o) => 'data: ' + JSON.stringify(o) + '\\n\\n';
  const chunk = (i) => sse({
    id: 'c', object: 'chat.completion.chunk', created: 0, model: 'mock',
    choices: [{ index: 0, delta: i < pieces.length ? { content: pieces[i] } : {},
                finish_reason: i < pieces.length ? null : finishReason }],
  });
  const fetchImpl = async (url, init) => {
    if (JSON.parse(String(init?.body ?? '{}')).stream !== true) {
      state.sent = state.total;
      return new Response(JSON.stringify({
        id: 'c', object: 'chat.completion', created: 0, model: 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    let i = 0;
    const body = new ReadableStream({
      pull(c) {
        if (i > pieces.length) { c.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n')); return c.close(); }
        state.sent += 1;
        c.enqueue(new TextEncoder().encode(chunk(i)));
        i += 1;
      },
      cancel() { state.cancelled = true; },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { state, fetchImpl };
}

const params = { model: 'mock', messages: [{ role: 'user', content: 'hi' }] };
const clientWith = (fetchImpl, options) =>
  withOutputGuard(new OpenAI({ apiKey: 'test', fetch: fetchImpl, maxRetries: 0 }), options);

// non-streaming: healthy passes, looping throws
{
  const { fetchImpl } = transport(HEALTHY);
  const completion = await clientWith(fetchImpl, {}).chat.completions.create(params);
  assert.equal(completion.choices[0].message.content, HEALTHY, 'healthy completion was altered');
}
{
  const { fetchImpl } = transport(LOOPING, 'length');
  const err = await clientWith(fetchImpl, { maxRepetition: 0.4, minLength: 12 })
    .chat.completions.create(params).then(() => null, (e) => e);
  assert.ok(err && err.name === 'DegenerateOutputError', 'a looping completion was not flagged');
}

// streaming: healthy intact and uncancelled
{
  const { state, fetchImpl } = transport(HEALTHY);
  const stream = await clientWith(fetchImpl, {}).chat.completions.create({ ...params, stream: true });
  let text = '';
  for await (const c of stream) text += c.choices[0]?.delta?.content ?? '';
  assert.equal(text, HEALTHY, 'healthy stream was not forwarded intact');
  assert.equal(state.cancelled, false, 'healthy stream was cancelled');
}

// streaming: the claim -- the response body is cancelled, early
{
  const { state, fetchImpl } = transport(LOOPING);
  const stream = await clientWith(fetchImpl, { maxRepetition: 0.4, maxTailLoop: 0.5, minLength: 12, onDegenerate: 'abort' })
    .chat.completions.create({ ...params, stream: true });
  for await (const _ of stream) { /* drain */ }
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(state.cancelled, 'the response body was never cancelled -- tokens still billed');
  assert.ok(state.sent < state.total, 'the whole stream was generated; nothing was saved');
  console.log('    runtime ok -- response body cancelled at ' + state.sent + '/' + state.total + ' chunks');
}
`;

const PEERS = {
  ai: {
    // The ends of the declared range, and every major between. Floors are
    // pinned exactly: a floor is a claim about the oldest release that works,
    // and `^5` would quietly test only the newest 5.x.
    versions: ['5.0.0', '6.0.250', '7.0.62'],
    probeTs: AI_PROBE_TS,
    probeMjs: AI_PROBE_MJS,
  },
  openai: {
    versions: ['4.0.0', '4.104.0', '5.23.2', '6.49.0', '7.4.0'],
    probeTs: OPENAI_PROBE_TS,
    probeMjs: OPENAI_PROBE_MJS,
  },
};

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['probe.ts'],
  },
  null,
  2,
);

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const [peerArg, ...versionArgs] = process.argv.slice(2);
const peerNames = peerArg ? [peerArg] : Object.keys(PEERS);
for (const name of peerNames) {
  if (!PEERS[name]) {
    console.error(`Unknown peer "${name}". Known: ${Object.keys(PEERS).join(', ')}`);
    process.exit(1);
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'lug-peer-'));
let failures = 0;
let checked = 0;

try {
  console.log('building and packing the local package...');
  run('npm', ['run', 'build'], root);
  run('npm', ['pack', '--pack-destination', workspace], root);
  const tarball = join(
    workspace,
    readdirSync(workspace).find((f) => f.endsWith('.tgz')),
  );

  for (const name of peerNames) {
    const peer = PEERS[name];
    const versions = versionArgs.length ? versionArgs : peer.versions;
    console.log(`\n### ${name}  (declared: ${pkg.peerDependencies[name]})`);

    for (const version of versions) {
      const dir = join(workspace, `${name}-${version}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'peer-probe', private: true, version: '1.0.0', type: 'module' }),
      );
      writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
      writeFileSync(join(dir, 'probe.ts'), peer.probeTs);
      writeFileSync(join(dir, 'probe.mjs'), peer.probeMjs);
      checked += 1;

      try {
        run(
          'npm',
          [
            'install',
            '--no-audit',
            '--no-fund',
            '--silent',
            `${name}@${version}`,
            `typescript@${pkg.devDependencies.typescript}`,
            tarball,
          ],
          dir,
        );

        /*
         * Read from disk rather than `require("<name>/package.json")`: not
         * every package exposes `./package.json` in its exports map, and
         * `openai` does not.
         */
        const resolved = JSON.parse(
          readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'),
        ).version;
        console.log(`\n${name}@${version} -> ${resolved}`);

        run('npx', ['tsc', '-p', 'tsconfig.json'], dir);
        console.log('    typecheck ok');

        console.log(
          execFileSync('node', ['probe.mjs'], {
            cwd: dir,
            encoding: 'utf8',
            env: { ...process.env, PEER_MAJOR: resolved.split('.')[0] },
          }).trimEnd(),
        );
      } catch (error) {
        failures += 1;
        const detail = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim();
        console.log(`\n${name}@${version} FAILED`);
        // npm --silent swallows its own resolution errors, so fall back to the
        // spawn message rather than reporting a failure with nothing attached.
        console.log((detail || error.message).trimEnd());
      }
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} of ${checked} peer versions failed — a declared range claims more than it supports.`);
  process.exit(1);
}

console.log(`\nall ${checked} peer versions ok`);
