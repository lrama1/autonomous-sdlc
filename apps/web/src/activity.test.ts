import { describe, expect, it } from 'vitest';
import { activityNote } from './activity';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('working or stuck', () => {
  it('says nothing when no run is live', () => {
    expect(activityNote(null, NOW)).toBeNull();
    expect(activityNote(undefined, NOW)).toBeNull();
  });

  it('is fine while the agent reported lately', () => {
    expect(activityNote(ago(0.2), NOW)).toEqual({
      tone: 'ok',
      text: 'Working. Last heard from the agent under a minute ago.',
    });
    expect(activityNote(ago(2), NOW)!.tone).toBe('ok');
  });

  it('asks for a look after a few quiet minutes, and says why it may be fine', () => {
    const n = activityNote(ago(6), NOW)!;
    expect(n.tone).toBe('quiet');
    expect(n.text).toContain('Quiet for 6 minutes');
    expect(n.text).toContain('Long installs');
  });

  it('calls it stuck after ten minutes, and says what the platform does about it', () => {
    const n = activityNote(ago(25), NOW)!;
    expect(n.tone).toBe('stuck');
    expect(n.text).toContain('Nothing heard for 25 minutes');
    expect(n.text).toContain('probably stuck');
    expect(activityNote(ago(130), NOW)!.text).toContain('2 hours 10 min');
  });
});
