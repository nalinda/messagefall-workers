/**
 * The `DurableObject` base class, resolved at module evaluation.
 *
 * `cloudflare:workers` exists only inside workerd. The `./durable` entry must still be
 * importable elsewhere — a Node or Bun process resolving the package, a type-level consumer, a
 * test — so the base is loaded dynamically and replaced by an inert stand-in with the same
 * constructor shape when the module is unavailable. Inside workerd the real class is used, which
 * is what makes `arm` / `cancel` callable over RPC.
 *
 * @module
 */

import type { DurableObject } from 'cloudflare:workers';

/**
 * Stand-in used outside workerd: holds `ctx` and `env` exactly like the real base.
 */
class StandaloneDurableObject {
  protected readonly ctx: DurableObjectState;
  protected readonly env: unknown;

  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

async function loadBase(): Promise<typeof DurableObject> {
  try {
    const mod = await import('cloudflare:workers');
    return mod.DurableObject;
  } catch {
    return StandaloneDurableObject as unknown as typeof DurableObject;
  }
}

/**
 * The class `FallbackTimer` extends: `DurableObject` from `cloudflare:workers` when available,
 * otherwise a stand-in with the same constructor.
 */
export const DurableObjectBase: typeof DurableObject = await loadBase();
