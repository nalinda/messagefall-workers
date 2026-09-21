/**
 * Fallback timer helpers: arm / cancel through the `FALLBACK_TIMER` Durable Object binding, the
 * per-kind chain timeouts, and the options registry the Durable Object reads its configuration
 * from.
 *
 * The Durable Object itself lives in `src/durable/fallback-timer.ts` (the `./durable` entry).
 * Everything the send (#3) and fallback (#7) paths need to talk to it is here, so the core never
 * imports `cloudflare:workers`: without the binding {@link armTimer} and {@link cancelTimer} are
 * no-ops and the package works with explicit failure statuses only.
 *
 * @module
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';

import type { MessagingEnv } from '../env.js';
import type { Templates } from '../templates.js';
import { createLogger } from './logger.js';
import type { MessagingOptions } from './messaging.js';
import { DEFAULT_LOCALE, pickRenderInput, type RenderInput } from './render-input.js';
import type { FallbackTimerClient } from './status.js';

const logger = createLogger();

/**
 * Arguments to `FallbackTimer#arm` / {@link armTimer}: the {@link RenderInput} to re-render
 * from, plus the message id and the delay. `locale` is required here (the issue's interface);
 * `to` and `email` are the render input's optional extras — the alarm fills whatever is missing
 * from the `in:<id>` KV entry the send wrote, but carrying the recipient in the object keeps a
 * long chain advancing after that entry's TTL has expired.
 */
export interface ArmTimerArgs extends RenderInput {
  /**
   * Internal message identifier; also the object's name (`idFromName`).
   */
  id: string;
  /**
   * Milliseconds from now until the alarm fires.
   */
  afterMs: number;
  /**
   * Locale the message is rendered in.
   */
  locale: string;
}

/**
 * The RPC surface of the `FallbackTimer` Durable Object as seen through a stub.
 */
export interface FallbackTimerStub {
  arm(args: ArmTimerArgs): Promise<void>;
  cancel(id: string): Promise<void>;
}

/**
 * Default chain timeout per template kind, in milliseconds.
 */
export const DEFAULT_CHAIN_TIMEOUT_MS: Readonly<Record<'otp' | 'notification', number>> = {
  otp: 30_000,
  notification: 300_000,
};

/**
 * The chain timeout for a template kind: the configured override, else the kind's default.
 *
 * @param kind - Template kind.
 * @param timeout - The `delivery.timeout` option, if configured.
 * @returns Milliseconds before the chain moves on when no status has arrived.
 */
export function chainTimeoutMs(
  kind: 'otp' | 'notification',
  timeout?: { otp?: number; notification?: number }
): number {
  return kind === 'otp'
    ? (timeout?.otp ?? DEFAULT_CHAIN_TIMEOUT_MS.otp)
    : (timeout?.notification ?? DEFAULT_CHAIN_TIMEOUT_MS.notification);
}

function stubFor(ns: DurableObjectNamespace, id: string): FallbackTimerStub {
  return ns.get(ns.idFromName(id)) as unknown as FallbackTimerStub;
}

/**
 * Arms (or re-arms) the fallback timer for a message: one object per message, addressed by
 * `idFromName(id)`. A no-op when the binding is absent.
 *
 * @param ns - The `FALLBACK_TIMER` binding, or undefined when the deployment has none.
 * @param args - What to store and when to fire.
 */
export async function armTimer(
  ns: DurableObjectNamespace | undefined,
  args: ArmTimerArgs
): Promise<void> {
  if (!ns) {
    return;
  }
  await stubFor(ns, args.id).arm(args);
}

/**
 * Cancels the fallback timer for a message: deletes its alarm and storage. A no-op when the
 * binding is absent.
 *
 * @param ns - The `FALLBACK_TIMER` binding, or undefined when the deployment has none.
 * @param id - Internal message identifier.
 */
export async function cancelTimer(
  ns: DurableObjectNamespace | undefined,
  id: string
): Promise<void> {
  if (!ns) {
    return;
  }
  await stubFor(ns, id).cancel(id);
}

/**
 * True when `value` looks like a `DurableObjectNamespace` rather than an already-adapted
 * {@link FallbackTimerClient}.
 *
 * @param value - The `FALLBACK_TIMER` binding or the `timer` option.
 * @returns Whether it is a namespace.
 */
export function isDurableObjectNamespace(value: unknown): value is DurableObjectNamespace {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { idFromName, get } = value as { idFromName?: unknown; get?: unknown };
  return typeof idFromName === 'function' && typeof get === 'function';
}

const clientCache = new WeakMap<DurableObjectNamespace, FallbackTimerClient>();

/**
 * Adapts a `FALLBACK_TIMER` namespace to the {@link FallbackTimerClient} boundary the send and
 * fallback paths use, so neither has to know it is talking to a Durable Object. Memoised per
 * namespace.
 *
 * @param ns - The binding.
 * @returns The client.
 */
export function namespaceTimerClient(ns: DurableObjectNamespace): FallbackTimerClient {
  let client = clientCache.get(ns);
  if (!client) {
    client = {
      arm: (id, timeoutMs, input) => armTimer(ns, armArgs(id, timeoutMs, input)),
      cancel: (id) => cancelTimer(ns, id),
    };
    clientCache.set(ns, client);
  }
  return client;
}

/**
 * Builds the {@link ArmTimerArgs} for a render input payload.
 *
 * @param id - Internal message identifier.
 * @param afterMs - Milliseconds until the alarm.
 * @param payload - The render input stashed with the timer, if any.
 * @returns The arm arguments, without undefined keys.
 */
export function armArgs(id: string, afterMs: number, payload?: RenderInput): ArmTimerArgs {
  return {
    ...pickRenderInput(payload ?? { input: undefined }),
    id,
    afterMs,
    locale: payload?.locale ?? DEFAULT_LOCALE,
  };
}

/**
 * Scopes (envs and app instances) for which the "timed fallback is off" line has been written
 * in this isolate.
 */
const timerOffAnnounced = new WeakSet<object>();

/**
 * Writes the one startup line saying timed fallback is off — `timer.off` — when neither the
 * `timer` option nor `env.FALLBACK_TIMER` is present. Chain fallback then runs on explicit
 * failure statuses only.
 *
 * The line is written once per `scope`, which defaults to `env`: `createMessaging` (called per
 * request) announces once per env in the isolate; `createMessagingApp` passes its app instance
 * so each app says it once on its first request, and the env is marked at the same time so the
 * routes' `createMessaging` calls do not repeat it.
 *
 * @param env - Worker bindings.
 * @param timer - The `timer` option, if any.
 * @param scope - The object the "once" is tied to; defaults to `env`.
 */
export function announceTimerOff(env: MessagingEnv, timer: unknown, scope: object = env): void {
  // Same "is there a timer at all" test as `resolveTimer`, inlined to keep this module free of
  // a value import from `./status.js` (which imports the adapter from here).
  const raw = timer ?? env.FALLBACK_TIMER;
  if ((raw && typeof raw === 'object') || timerOffAnnounced.has(scope)) {
    return;
  }
  timerOffAnnounced.add(scope);
  timerOffAnnounced.add(env);
  logger.info('timer.off');
}

const registry: { options: MessagingOptions | undefined } = { options: undefined };

/**
 * Records the messaging options of this Worker for the `FallbackTimer` Durable Object, which
 * re-creates the core (templates, providers, store) from them when its alarm fires. Called by
 * `createMessagingApp` and `createMessaging`.
 *
 * This is a module-level singleton and the last call wins, so a Worker must configure one set of
 * options: two `createMessaging` calls with different options in one isolate would hand the
 * alarm whichever ran last. An isolate woken only by an alarm executes module evaluation and
 * nothing else before the handler runs, so the registering call must happen at module top level
 * of the Worker module that exports `FallbackTimer` — `createMessagingApp(...)` as a module-scope
 * `const`, as in the README's quick start — not lazily inside a request handler. Otherwise the
 * alarm finds no options and throws (keeping its storage for the platform's retry).
 *
 * @param options - The options the Worker was configured with.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerMessagingOptions<T extends Templates<any>>(
  options: MessagingOptions<T>
): void {
  registry.options = options;
}

/**
 * Forgets the registered options: models a fresh isolate (one woken by an alarm before any
 * `createMessagingApp` ran) in a test process where the module is loaded once.
 */
export function resetMessagingOptions(): void {
  registry.options = undefined;
}

/**
 * The options recorded by {@link registerMessagingOptions}, if any.
 *
 * @returns The options, or undefined when no `createMessagingApp` / `createMessaging` call has
 * run in this isolate yet (see {@link registerMessagingOptions} for why that must happen at
 * module top level).
 */
export function registeredMessagingOptions(): MessagingOptions | undefined {
  return registry.options;
}
