/**
 * Tests for the cross-isolate advance lease in `src/core/advance-lock.ts`.
 *
 * The in-isolate half of `withAdvanceLock` is exercised through the webhook path; this spec
 * drives the KV lease itself, which is the half that decides whether a redelivered `failed`
 * webhook landing in a second isolate sends the same one-time code twice.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';

import { withAdvanceLock } from '../../src/core/advance-lock.js';
import { rejection } from '../helpers/client.js';
import { captureConsole, memoryKV } from '../helpers/messaging.js';

/**
 * A KV namespace whose `get` always throws, standing in for a KV fault mid-advance.
 */
function faultyGetKV(): KVNamespace {
  return {
    ...memoryKV(),
    get: () => Promise.reject(new Error('kv unavailable')),
  };
}

describe('withAdvanceLock cross-isolate lease', () => {
  it('skips the advance and warns when another isolate holds a live lease', async () => {
    const kv = memoryKV();
    const id = 'msg-live-lease';
    await kv.put(`lock:${id}`, String(Date.now() + 10_000));

    let didRun = false;
    const captured = captureConsole(['warn']);
    try {
      await withAdvanceLock(kv, id, () => {
        didRun = true;
        return Promise.resolve();
      });
    } finally {
      captured.restore();
    }

    expect(didRun).toBe(false);
    expect(captured.logs.join('\n')).toContain('fallback.advance-skipped');
    // The holder's lease is left alone: a skipped advance must not release someone else's lock.
    expect(kv.dump().get(`lock:${id}`)).toBeDefined();
  });

  it('runs the advance when the stored lease has already expired', async () => {
    const kv = memoryKV();
    const id = 'msg-expired-lease';
    await kv.put(`lock:${id}`, String(Date.now() - 1));

    let didRun = false;
    await withAdvanceLock(kv, id, () => {
      didRun = true;
      return Promise.resolve();
    });

    expect(didRun).toBe(true);
    expect(kv.dump().has(`lock:${id}`)).toBe(false);
  });

  it('runs the advance when reading the lease throws, rather than losing fallback', async () => {
    const kv = faultyGetKV();
    let didRun = false;

    await withAdvanceLock(kv, 'msg-kv-fault', () => {
      didRun = true;
      return Promise.resolve();
    });

    expect(didRun).toBe(true);
  });

  it('deletes the lease after the advance resolves', async () => {
    const kv = memoryKV();
    const id = 'msg-release-on-success';

    await withAdvanceLock(kv, id, () => Promise.resolve());

    expect(kv.dump().has(`lock:${id}`)).toBe(false);
  });

  it('deletes the lease after the advance rejects, so a failure cannot wedge the chain', async () => {
    const kv = memoryKV();
    const id = 'msg-release-on-failure';

    const error = await rejection(
      withAdvanceLock(kv, id, () => Promise.reject(new Error('advance blew up')))
    );

    expect((error as Error).message).toBe('advance blew up');

    expect(kv.dump().has(`lock:${id}`)).toBe(false);
  });
});
