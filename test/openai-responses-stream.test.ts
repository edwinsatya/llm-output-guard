import { describe, it, expect } from 'vitest';
import { ResponseStream } from 'openai/lib/responses/ResponseStream.mjs';
import { withOutputGuard } from '../src/openai.js';
import { DegenerateOutputError } from '../src/check.js';
import { presets } from '../src/presets.js';
import type { Verdict } from '../src/types.js';

/**
 * `responses.stream()`, guarded -- against the real `ResponseStream`.
 *
 * This was deliberately unguarded until now, and the reason was sound: a
 * `ResponseStream` extends `EventStream` and can be read **six** ways
 * (`for await`, `finalResponse()`, `done()`, `on()`, `once()`/`emitted()`,
 * `events()`), so wrapping its iterator would have guarded one and left five
 * reading an unchecked stream. Half a guard on the SDK's current default
 * streaming surface is worse than none, because it looks like coverage.
 *
 * What makes it tractable is that all six are fed by one event pump, so a
 * single listener sees every delta however the caller reads. Detection and
 * cancellation therefore work everywhere; *throwing* works only where there is
 * an error channel, and these tests pin which paths have one.
 *
 * Built with `ResponseStream.fromReadableStream`, which is public API, so these
 * run through the SDK's real accumulator and its real abort machinery rather
 * than a double that could drift from either.
 */

/** A faithful Responses event sequence -- the protocol the accumulator validates. */
function responseEvents(deltas: readonly string[], incomplete?: string): unknown[] {
  const base = { id: 'resp_1', object: 'response', status: 'in_progress', output: [], output_text: '' };
  const msg = { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] };
  const text = deltas.join('');

  const events: unknown[] = [
    { type: 'response.created', response: { ...base }, sequence_number: 0 },
    { type: 'response.in_progress', response: { ...base }, sequence_number: 1 },
    { type: 'response.output_item.added', output_index: 0, item: msg, sequence_number: 2 },
    {
      type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }, sequence_number: 3,
    },
  ];
  deltas.forEach((delta, i) =>
    events.push({
      type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0,
      content_index: 0, delta, sequence_number: 4 + i,
    }),
  );
  events.push({
    type: 'response.output_text.done', item_id: 'msg_1', output_index: 0,
    content_index: 0, text, sequence_number: 900,
  });
  const finished = {
    ...base,
    status: incomplete ? 'incomplete' : 'completed',
    output: [{ ...msg, status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    output_text: text,
    ...(incomplete ? { incomplete_details: { reason: incomplete } } : {}),
  };
  events.push({
    type: incomplete ? 'response.incomplete' : 'response.completed',
    response: finished,
    sequence_number: 999,
  });
  return events;
}

const streamOf = (deltas: readonly string[], incomplete?: string) =>
  ResponseStream.fromReadableStream(
    new ReadableStream({
      start(controller) {
        for (const event of responseEvents(deltas, incomplete)) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
  );

const LOOP = Array.from({ length: 60 }, () => 'Yes. ');
const HEALTHY = [
  'The connection pool is created once per worker process ',
  'and is never shared across them. That single fact drives ',
  'most of the confusion teams have with the retry budget, ',
  'because the budget is expressed per pool rather than per service. ',
];

function recorder() {
  const seen: Verdict[] = [];
  return { seen, onVerdict: (v: Verdict) => seen.push(v) };
}

/** A client whose `responses.stream()` hands back a real ResponseStream. */
const clientStreaming = (deltas: readonly string[], incomplete?: string) => ({
  responses: { stream: (_params?: unknown) => streamOf(deltas, incomplete) },
});

describe('responses.stream(): the loop is caught', () => {
  it('throws into a for-await consumer, carrying the verdict', async () => {
    const { seen, onVerdict } = recorder();
    const client = withOutputGuard(clientStreaming(LOOP), { ...presets.chat, onVerdict });

    let received = 0;
    await expect(
      (async () => {
        for await (const _event of client.responses.stream({})) received += 1;
      })(),
    ).rejects.toThrow(DegenerateOutputError);

    expect(received, 'the loop was cut short').toBeLessThan(LOOP.length);
    expect(seen.some((v) => !v.ok)).toBe(true);
  });

  /* The path the original comment named as the reason not to ship a partial guard. */
  it('rejects finalResponse(), which a naive iterator wrap would have missed', async () => {
    const { seen, onVerdict } = recorder();
    const client = withOutputGuard(clientStreaming(LOOP), { ...presets.chat, onVerdict });

    await expect(client.responses.stream({}).finalResponse()).rejects.toThrow(
      DegenerateOutputError,
    );
    expect(seen.some((v) => !v.ok)).toBe(true);
  });

  it('rejects done()', async () => {
    const client = withOutputGuard(clientStreaming(LOOP), presets.chat);
    await expect(client.responses.stream({}).done()).rejects.toThrow(DegenerateOutputError);
  });

  /**
   * An `on()`-only consumer has no error channel, so it cannot be thrown into.
   * What it gets instead is the report and a stream that stops -- which is the
   * half that actually saves tokens.
   */
  it('reports and stops for an on()-only consumer, without throwing', async () => {
    const { seen, onVerdict } = recorder();
    const client = withOutputGuard(clientStreaming(LOOP), {
      ...presets.chat,
      onDegenerate: 'abort',
      onVerdict,
    });

    const stream = client.responses.stream({});
    let deltas = 0;
    stream.on('response.output_text.delta', () => {
      deltas += 1;
    });
    await stream.done().catch(() => undefined);

    expect(seen.some((v) => !v.ok), 'it was judged').toBe(true);
    expect(deltas, 'and cut short rather than run to completion').toBeLessThan(LOOP.length);
  });

  it('cancels the upstream request', async () => {
    const client = withOutputGuard(clientStreaming(LOOP), {
      ...presets.chat,
      onDegenerate: 'abort',
    });
    const stream = client.responses.stream({});
    for await (const _event of stream) { /* drain */ }
    expect(stream.aborted, 'the connection was closed, not just our loop').toBe(true);
  });

  it('measures how much was never produced', async () => {
    const client = withOutputGuard(clientStreaming(LOOP), {
      ...presets.chat,
      onDegenerate: 'abort',
    });
    let events = 0;
    for await (const _event of client.responses.stream({})) events += 1;
    const total = responseEvents(LOOP).length;
    process.stdout.write(
      `  responses.stream guard: ${events}/${total} events consumed -> ` +
        `${Math.round((1 - events / total) * 100)}% not read after the guard fired ` +
        '(mock transport; not a billing figure)\n',
    );
    expect(events).toBeLessThan(total);
  });
});

describe('responses.stream(): healthy output is untouched', () => {
  it('runs to completion and reports a passing verdict', async () => {
    const { seen, onVerdict } = recorder();
    const client = withOutputGuard(clientStreaming(HEALTHY), { ...presets.chat, onVerdict });

    let received = 0;
    for await (const _event of client.responses.stream({})) received += 1;

    expect(received).toBe(responseEvents(HEALTHY).length);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ok, JSON.stringify(seen[0]?.reasons)).toBe(true);
  });

  it('still resolves finalResponse() with the accumulated response', async () => {
    const client = withOutputGuard(clientStreaming(HEALTHY), presets.chat);
    const response = await client.responses.stream({}).finalResponse();
    expect(response.status).toBe('completed');
    expect(response.output_text).toBe(HEALTHY.join(''));
  });

  /* `incomplete_details.reason` is this API's finish reason, and the terminal
     event is the only place it appears mid-stream. */
  it('reads max_output_tokens off response.incomplete as truncation', async () => {
    const { seen, onVerdict } = recorder();
    const client = withOutputGuard(clientStreaming(HEALTHY, 'max_output_tokens'), {
      ...presets.chat,
      maxTruncation: 0.75,
      onVerdict,
    });

    for await (const _event of client.responses.stream({})) { /* drain */ }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.reasons.map((r) => r.code)).toContain('TRUNCATED');
  });
});

describe('responses.stream(): everything else on the stream still works', () => {
  it('leaves non-wrapped members reachable', async () => {
    const client = withOutputGuard(clientStreaming(HEALTHY), presets.chat);
    const stream = client.responses.stream({});

    expect(typeof stream.on).toBe('function');
    expect(typeof stream.off).toBe('function');
    expect(typeof stream.abort).toBe('function');
    expect(stream.controller).toBeInstanceOf(AbortController);

    await stream.done();
    expect(stream.ended).toBe(true);
  });

  it('does not fail a tool-calling turn that carries no prose', async () => {
    const { seen, onVerdict } = recorder();
    const toolStream = (_params?: unknown) =>
      ResponseStream.fromReadableStream(
        new ReadableStream({
          start(controller) {
            const base = { id: 'resp_1', object: 'response', status: 'in_progress', output: [], output_text: '' };
            const call = {
              id: 'fc_1', type: 'function_call', status: 'in_progress',
              name: 'get_weather', arguments: '', call_id: 'call_1',
            };
            const events = [
              { type: 'response.created', response: { ...base }, sequence_number: 0 },
              { type: 'response.output_item.added', output_index: 0, item: call, sequence_number: 1 },
              {
                type: 'response.output_item.done', output_index: 0,
                item: { ...call, status: 'completed', arguments: '{"city":"Jakarta"}' },
                sequence_number: 2,
              },
              {
                type: 'response.completed',
                response: {
                  ...base, status: 'completed',
                  output: [{ ...call, status: 'completed', arguments: '{"city":"Jakarta"}' }],
                },
                sequence_number: 3,
              },
            ];
            for (const e of events) controller.enqueue(new TextEncoder().encode(`${JSON.stringify(e)}\n`));
            controller.close();
          },
        }),
      );

    const client = withOutputGuard(
      { responses: { stream: toolStream } },
      { ...presets.chat, onVerdict },
    );

    for await (const _event of client.responses.stream({})) { /* drain */ }

    // No prose to judge, so nothing is reported -- never `EMPTY: 1`.
    expect(seen).toHaveLength(0);
  });
});
