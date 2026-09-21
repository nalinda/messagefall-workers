/**
 * Test-environment workaround for Miniflare's binding proxies under Bun.
 *
 * Miniflare hands bindings back as `Proxy` objects whose `get` trap does not serve own
 * properties that Bun's runtime reads off the target, so a KV binding can come back with
 * methods missing. This patches the global `Proxy` constructor so every handler prefers an
 * own property on the target before falling through to the original trap.
 *
 * It is a test-only shim: it mutates a global and must never ship in `src/`. `createMiniflareKV`
 * applies it before constructing a Miniflare instance; nothing else should need it.
 *
 * @module
 */

import { describe, expect, it } from 'bun:test';

interface PatchableProxy {
  __mfPatched?: boolean;
}

function wrapHandler(handler: ProxyHandler<Record<string | symbol, unknown>>): void {
  if (typeof handler.get !== 'function') {
    return;
  }
  const origGet = handler.get.bind(handler);
  handler.get = (target, key, receiver) => {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      return target[key as string];
    }
    return origGet(target, key, receiver) as unknown;
  };
}

/**
 * Installs the Proxy patch once per process. Safe to call repeatedly.
 */
export function patchMiniflareProxy(): void {
  const OriginalProxy = Proxy;
  const patchable = OriginalProxy as unknown as PatchableProxy;
  if (patchable.__mfPatched) {
    return;
  }

  const PatchedProxy = new OriginalProxy(OriginalProxy, {
    construct(target, constructorArgs, newTarget) {
      const [, handler] = constructorArgs as [
        Record<string | symbol, unknown>,
        ProxyHandler<Record<string | symbol, unknown>>,
      ];
      wrapHandler(handler);
      return Reflect.construct(target, constructorArgs, newTarget) as object;
    },
  });

  (PatchedProxy as unknown as PatchableProxy).__mfPatched = true;
  // eslint-disable-next-line unicorn/no-global-object-property-assignment
  (globalThis as unknown as { Proxy: unknown }).Proxy = PatchedProxy;
}

/**
 * Self-test (see "Testing Guidelines" in `src/providers/README.md`): a helper file with
 * no `describe` of its own never shows up in the runner's output, which makes it look like a
 * red-phase test that silently failed to run. This runs with whichever spec imports the helper.
 */
describe('test/helpers/miniflare-proxy', () => {
  it('loads', () => {
    expect(typeof patchMiniflareProxy).toBe('function');
  });
});
