/**
 * Miniflare-backed KV binding for the delivery-status store specs.
 *
 * Record and store types are not restated here: tests import them from
 * `src/core/status.ts`, so a change to the real shape breaks the tests that assert on it.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import { patchMiniflareProxy } from './miniflare-proxy.js';

/**
 * Creates an isolated Miniflare instance with a test KV namespace.
 *
 * @returns Object containing the KV binding and a dispose callback.
 */
export async function createMiniflareKV(): Promise<{
  kv: KVNamespace;
  dispose: () => Promise<void>;
}> {
  patchMiniflareProxy();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("OK"); } }',
      kvNamespaces: ['STATUS_KV'],
      compatibilityDate: '2024-01-01',
    })
  );

  const bindings = await mf.getBindings<{ STATUS_KV: KVNamespace }>();
  return {
    kv: bindings.STATUS_KV,
    dispose: async () => {
      await mf.dispose();
    },
  };
}

/**
 * Self-test (AGENTS.md, "Shared test fixtures/helpers under `test/helpers/`"): a helper file with
 * no `describe` of its own never shows up in the runner's output, which makes it look like a
 * red-phase test that silently failed to run. This runs with whichever spec imports the helper.
 */
describe('test/helpers/status', () => {
  it('loads', () => {
    expect(typeof createMiniflareKV).toBe('function');
  });
});
