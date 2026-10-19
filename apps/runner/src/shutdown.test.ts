import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { saveOnTerminate } from './shutdown.js';

const setup = (save: () => Promise<void>, limitMs?: number) => {
  const target = new EventEmitter();
  const exits: number[] = [];
  const logs: string[] = [];
  saveOnTerminate(
    save,
    (c) => exits.push(c),
    (l) => logs.push(l),
    target as never,
    limitMs,
  );
  return { target, exits, logs };
};
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('saveOnTerminate', () => {
  it('saves, then exits with 143, and only once however often it is told', async () => {
    let saved = 0;
    const { target, exits, logs } = setup(async () => void saved++);
    target.emit('SIGTERM');
    target.emit('SIGTERM');
    await settle();
    expect(saved).toBe(1);
    expect(exits).toEqual([143]);
    expect(logs[0]).toContain('saving the run');
  });

  it('exits anyway when the save fails', async () => {
    const { target, exits, logs } = setup(async () => {
      throw new Error('HTTP 500');
    });
    target.emit('SIGTERM');
    await settle();
    expect(exits).toEqual([143]);
    expect(logs.join('\n')).toContain('could not save the files: HTTP 500');
  });

  it('gives up on a save that takes too long', async () => {
    const { target, exits, logs } = setup(() => new Promise(() => {}), 10);
    target.emit('SIGTERM');
    await settle();
    expect(exits).toEqual([143]);
    expect(logs.join('\n')).toContain('took longer than');
  });
});
