/**
 * Minimal ULID generator (26 Crockford base32 chars: 48-bit millisecond time + 80 random bits).
 * Lexicographically sortable by creation time, which is why message ids use it.
 *
 * @module
 */

// Crockford base32 (no I, L, O, U). Not a secret, despite the entropy the linter sees.
// eslint-disable-next-line no-secrets/no-secrets
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(time: number): string {
  let out = '';
  let remaining = time;
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = '';
  for (const byte of bytes) {
    out += ALPHABET[byte % 32];
  }
  return out;
}

/**
 * Generates a ULID for the current time.
 *
 * @param now - Milliseconds since the epoch (defaults to `Date.now()`).
 * @returns A 26-character ULID.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}
