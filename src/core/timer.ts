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

import type { Templates } from '../templates.js';
import type { MessagingOptions } from './messaging.js';
import type { RenderInput } from './render-input.js';
import type { FallbackTimerClient } from './status.js';

/**
 * Arguments to `FallbackTimer#arm` / {@link armTimer}.
 *
 * `to` and `email` are optional extras beyond the issue's interface: the alarm fills whatever is
 * missing from the `in:<id>` KV entry the send wrote, but carrying the recipient in the object
 * keeps a long chain advancing after that entry's TTL has expired.
 */
export interface ArmTimerArgs {
  /**
   * Internal message identifier; also the object's name (`idFromName`).
   */
  id: string;
  /**
   * Milliseconds from now until the alarm fires.
   */
  afterMs: number;
  /**
   * Raw template input, as the caller passed it to `send`.
   */
  input: unknown;
  /**
   * Locale the message is rendered in.
   */
  locale: string;
  /**
   * Recipient phone number in E.164 form, when known.
   */
  to?: string;
  /**
   * Recipient email address, when the send had one.
   */
  email?: string;
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
      setState: (id, timeoutMs, input) => armTimer(ns, armArgs(id, timeoutMs, input)),
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
    id,
    afterMs,
    input: payload?.input,
    locale: payload?.locale ?? 'en',
    ...(payload?.to !== undefined && { to: payload.to }),
    ...(payload?.email !== undefined && { email: payload.email }),
  };
}

const registry: { options: MessagingOptions | undefined } = { options: undefined };

/**
 * Records the messaging options of this Worker for the `FallbackTimer` Durable Object, which
 * re-creates the core (templates, providers, store) from them when its alarm fires. Called by
 * `createMessagingApp` and `createMessaging`; the last call wins. This is why the Durable Object
 * must be exported from the same Worker module that calls `createMessagingApp`: both run in the
 * isolate the alarm fires in.
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
 * The options recorded by {@link registerMessagingOptions}, if any.
 *
 * @returns The options, or undefined when no `createMessagingApp` / `createMessaging` call has
 * happened in this isolate.
 */
export function registeredMessagingOptions(): MessagingOptions | undefined {
  return registry.options;
}
