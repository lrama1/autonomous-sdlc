import { describe, expect, it } from 'vitest';
import type { LogEventDto } from '@sdlc/schemas';
import { describeEvent, toolSummary } from './logFormat';
import { mergeEvents } from './useLog';

describe('drawing an event in the log', () => {
  it('shows a tool call as the tool and what it was asked, and a result as ok or failed', () => {
    expect(
      describeEvent({
        type: 'tool.call',
        payload: { name: 'Bash', input: '{"command":"npm test\\n  --silent"}' },
      }),
    ).toEqual({
      kind: 'tool',
      label: 'Bash',
      text: 'npm test --silent',
    });
    expect(
      describeEvent({
        type: 'tool.call',
        payload: { name: 'Read', input: '{"file_path":"src/a.js"}' },
      }).text,
    ).toBe('src/a.js');
    expect(
      describeEvent({ type: 'tool.result', payload: { ok: true, summary: '12 passed' } }),
    ).toMatchObject({ kind: 'result', label: 'ok', ok: true, text: '12 passed' });
    expect(
      describeEvent({ type: 'tool.result', payload: { ok: false, summary: 'exit 1' } }),
    ).toMatchObject({ label: 'failed', ok: false });
  });

  it('shows what the agent says, the files it changes, and the steps of a run', () => {
    expect(
      describeEvent({
        type: 'message',
        payload: { role: 'assistant', text: 'Reading the design.' },
      }),
    ).toMatchObject({ kind: 'message', text: 'Reading the design.' });
    expect(
      describeEvent({ type: 'file.changed', payload: { path: 'src/x.js', tool: 'Write' } }),
    ).toEqual({ kind: 'file', label: 'Write', text: 'src/x.js' });
    expect(
      describeEvent({ type: 'engine.started', payload: { engine: 'claude-code', model: 'sonnet' } })
        .text,
    ).toBe('claude-code (sonnet)');
    expect(describeEvent({ type: 'run.parked', payload: {} }).label).toBe('waiting for a person');
    expect(describeEvent({ type: 'interaction.raised', payload: { kind: 'decision' } }).kind).toBe(
      'ask',
    );
    expect(describeEvent({ type: 'run.finished', payload: { exitReason: 'succeeded' } }).kind).toBe(
      'run',
    );
    expect(describeEvent({ type: 'run.finished', payload: { exitReason: 'timed_out' } }).kind).toBe(
      'error',
    );
  });

  it('shows an event it does not know as its type and payload, and clips what is long', () => {
    expect(describeEvent({ type: 'something.new', payload: { a: 1 } })).toEqual({
      kind: 'other',
      label: 'something.new',
      text: '{"a":1}',
    });
    expect(toolSummary('x'.repeat(1000)).length).toBeLessThan(500);
    expect(toolSummary('not json {')).toBe('not json {');
    expect(toolSummary({ weird: true })).toBe('{"weird":true}');
  });
});

describe('keeping the log up to date', () => {
  const ev = (gid: number): LogEventDto => ({
    id: `id${gid}`,
    gid,
    runId: 'r',
    seq: gid,
    ts: '2026-10-30T12:00:00.000Z',
    type: 'message',
    payload: {},
  });

  it('adds only what is new, in order, and ignores what the overlap brought again', () => {
    const have = [ev(1), ev(2), ev(3)];
    expect(mergeEvents(have, [ev(2), ev(3)])).toBe(have);
    expect(mergeEvents(have, [ev(5), ev(3), ev(4)]).map((e) => e.gid)).toEqual([1, 2, 3, 4, 5]);
    // An event stored a moment late, below the newest one seen, still finds its place.
    expect(mergeEvents([ev(1), ev(3)], [ev(2)]).map((e) => e.gid)).toEqual([1, 2, 3]);
  });

  it('keeps the newest events when there are too many', () => {
    const all = Array.from({ length: 10 }, (_, i) => ev(i + 1));
    expect(mergeEvents([], all, 4).map((e) => e.gid)).toEqual([7, 8, 9, 10]);
  });
});
