import { describe, it, expect, vi } from 'vitest';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { outputGuard } from '../src/ai-sdk.js';
import { DegenerateOutputError } from '../src/check.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

const HEALTHY =
  'Redis pub/sub is the right primitive here. Each server subscribes to the room ' +
  'channel and publishes moves to it, so fan-out no longer depends on which instance ' +
  'a given socket happens to land on. The tradeoff is at-most-once delivery, so a ' +
  'client reconnecting mid-game refetches state rather than replaying it.';

const LOOPING =
  'Your strongest area is TypeScript. ' + 'You should add tests to this repo. '.repeat(60);

/** Either spec's shape: a bare string in v2, an object in v4. */
type FinishReason = string | { unified?: string; raw?: string };

interface Part {
  type: string;
  id?: string;
  text?: string;
  delta?: string;
  finishReason?: FinishReason;
  usage?: unknown;
}

/** A stream of provider parts, the way the SDK delivers them. */
function partsStream(text: string, finishReason: FinishReason = { unified: 'stop', raw: 'stop' }) {
  const chunks: Part[] = [{ type: 'text-start', id: '0' }];
  for (let i = 0; i < text.length; i += 16) {
    chunks.push({ type: 'text-delta', id: '0', delta: text.slice(i, i + 16) });
  }
  chunks.push({ type: 'text-end', id: '0' });
  chunks.push({ type: 'finish', finishReason, usage: {} });

  let generated = 0;
  return {
    get generated() {
      return generated;
    },
    stream: new ReadableStream<Part>({
      pull(controller) {
        const next = chunks.shift();
        if (!next) return controller.close();
        // Parts this stub was actually pulled for. A cancelled stream shows
        // up as parts never requested -- of a mock, so it measures the SDK
        // cancellation path, not tokens a provider never billed.
        generated += 1;
        controller.enqueue(next);
      },
    }),
  };
}

async function drain(stream: ReadableStream<unknown>): Promise<string> {
  let text = '';
  for await (const part of stream as unknown as AsyncIterable<Record<string, string>>) {
    if (part.type === 'text-delta') text += part.delta;
  }
  return text;
}

describe('outputGuard as AI SDK middleware', () => {
  /*
   * The point of this file. The adapter is structurally typed rather than
   * importing from `ai`, which keeps the dependency optional but means only a
   * real assignment proves the shapes still line up. If the SDK changes its
   * middleware contract, this stops compiling -- which is the intent.
   */
  it('satisfies the real LanguageModelMiddleware type', () => {
    const middleware: LanguageModelMiddleware = outputGuard(presets.chat);
    expect(middleware.wrapGenerate).toBeTypeOf('function');
    expect(middleware.wrapStream).toBeTypeOf('function');
    expect(() =>
      wrapLanguageModel({
        model: { specificationVersion: 'v4', provider: 'test', modelId: 'test' } as never,
        middleware,
      }),
    ).not.toThrow();
  });

  describe('wrapGenerate', () => {
    const generateOf = (text: string, finishReason: FinishReason) => () =>
      Promise.resolve({ content: [{ type: 'text', text }], finishReason });

    it('passes healthy output through untouched', async () => {
      const guard = outputGuard(presets.chat);
      const result = await guard.wrapGenerate({
        doGenerate: generateOf(HEALTHY, { unified: 'stop', raw: 'stop' }),
      });
      expect(result.content?.[0].text).toBe(HEALTHY);
    });

    it('throws a retryable DegenerateOutputError on a loop', async () => {
      const guard = outputGuard(presets.chat);
      await expect(
        guard.wrapGenerate({ doGenerate: generateOf(LOOPING, { unified: 'length', raw: 'length' }) }),
      ).rejects.toBeInstanceOf(DegenerateOutputError);
    });

    it('reads the v4 finishReason object and the v2 string alike', async () => {
      const seen: Verdict[] = [];
      const guard = outputGuard({
        ...presets.chat,
        maxTruncation: 0.75,
        onDegenerate: 'ignore',
        onVerdict: (v) => seen.push(v),
      });
      await guard.wrapGenerate({ doGenerate: generateOf(HEALTHY, { unified: 'length' }) });
      await guard.wrapGenerate({ doGenerate: generateOf(HEALTHY, 'length') });
      expect(seen).toHaveLength(2);
      for (const verdict of seen) {
        expect(verdict.reasons.map((r) => r.code)).toContain('TRUNCATED');
      }
    });
  });

  describe('wrapStream', () => {
    it('forwards a healthy stream and reports the final verdict once', async () => {
      const onVerdict = vi.fn();
      const guard = outputGuard({ ...presets.chat, onVerdict });
      const result = await guard.wrapStream({ doStream: () => Promise.resolve(partsStream(HEALTHY)) });

      expect(await drain(result.stream)).toBe(HEALTHY);
      expect(onVerdict).toHaveBeenCalledOnce();
      expect(onVerdict.mock.calls[0][0].ok).toBe(true);
      expect(onVerdict.mock.calls[0][1]).toEqual({ streaming: true });
    });

    it("cancels the provider's stream when the model starts looping", async () => {
      const source = partsStream(LOOPING);
      const guard = outputGuard({ ...presets.chat, onDegenerate: 'abort' });
      const result = await guard.wrapStream({ doStream: () => Promise.resolve(source) });

      const delivered = await drain(result.stream);
      const total = Math.ceil(LOOPING.length / 16) + 3;

      expect(delivered.length).toBeLessThan(LOOPING.length / 2);
      // The saving that matters: parts the provider was never asked to make.
      expect(source.generated).toBeLessThan(total);
    });

    it("errors the stream on 'throw' so a retry layer can see it", async () => {
      const guard = outputGuard({ ...presets.chat, onDegenerate: 'throw' });
      const result = await guard.wrapStream({
        doStream: () => Promise.resolve(partsStream(LOOPING)),
      });
      await expect(drain(result.stream)).rejects.toBeInstanceOf(DegenerateOutputError);
    });

    it("delivers everything on 'ignore' while still reporting", async () => {
      const onVerdict = vi.fn();
      const guard = outputGuard({ ...presets.chat, onDegenerate: 'ignore', onVerdict });
      const result = await guard.wrapStream({
        doStream: () => Promise.resolve(partsStream(LOOPING)),
      });

      expect(await drain(result.stream)).toBe(LOOPING);
      expect(onVerdict.mock.calls.some(([v]) => !v.ok)).toBe(true);
    });

    it('does not report a final verdict for a stream it cut short', async () => {
      const onVerdict = vi.fn();
      const guard = outputGuard({ ...presets.chat, onDegenerate: 'abort', onVerdict });
      const result = await guard.wrapStream({
        doStream: () => Promise.resolve(partsStream(LOOPING)),
      });
      await drain(result.stream);
      // Exactly one: the failure. Not a second describing our own abort.
      expect(onVerdict).toHaveBeenCalledOnce();
      expect(onVerdict.mock.calls[0][0].ok).toBe(false);
    });

    it('preserves other fields on the stream result', async () => {
      const guard = outputGuard(presets.chat);
      const result = await guard.wrapStream({
        doStream: () =>
          Promise.resolve({ ...partsStream(HEALTHY), request: { body: 'x' } } as never),
      });
      expect((result as { request?: { body: string } }).request).toEqual({ body: 'x' });
    });
  });
});
