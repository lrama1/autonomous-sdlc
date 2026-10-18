import { randomBytes } from 'node:crypto';

/** UUIDv7: 48-bit millisecond timestamp, then random bits. Sorts by creation time. */
export function uuidv7(now: number = Date.now(), rand: Uint8Array = randomBytes(10)): string {
  const b = new Uint8Array(16);
  let t = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b.set(rand.subarray(0, 10), 6);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70; // version 7
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
