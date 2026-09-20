/**
 * Test helpers for the FallbackTimer Durable Object (Issue #8).
 *
 * Provides:
 * - a fake Durable Object runtime (state + storage + namespace) driven by a mocked clock, so
 *   the arm → timeout → alarm → cleanup lifecycle can be exercised in-process against a local
 *   status store, with no Worker or wrangler involved;
 * - a loader for the timer API (`FallbackTimer`, `armTimer`, `cancelTimer`) that falls back to
 *   inert stubs while the module is not implemented, so the tests fail on their assertions and
 *   not on a missing import;
 * - recording providers and a template catalogue shared by the timer specs.
 *
 * @module
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { mock, setSystemTime } from 'bun:test';

import type { MessagingEnv } from '../../src/env.js';
import type {
  OutboundMeta,
  Provider,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
  StatusEvent,
} from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';

/**
 * Arguments accepted by `FallbackTimer#arm` and `armTimer`.
 */
export interface ArmArgs {
  id: string;
  afterMs: number;
  input: unknown;
  locale: string;
  /**
   * Recipient for the fallback attempt. The record does not carry it, so the timer must (the
   * `in:<id>` key is not written by send); `advanceChain` renders `to` from the stored value.
   */
  to?: string;
}

/**
 * The public surface of a FallbackTimer instance (RPC methods).
 */
export interface FallbackTimerInstance {
  arm(args: ArmArgs): Promise<void>;
  cancel(id: string): Promise<void>;
  alarm(): Promise<void>;
}

/**
 * Constructor shape of the Durable Object class.
 */
export type FallbackTimerCtor = new (ctx: FakeDurableObjectState, env: unknown) => FallbackTimerInstance;

/**
 * The timer API under test.
 */
export interface TimerApi {
  FallbackTimer: FallbackTimerCtor;
  armTimer: (ns: DurableObjectNamespace | undefined, args: ArmArgs) => Promise<void>;
  cancelTimer: (ns: DurableObjectNamespace | undefined, id: string) => Promise<void>;
}

/**
 * Minimal `cloudflare:workers` shim so the class can be loaded under bun. Registered once,
 * before the timer module is imported.
 */
class FakeDurableObjectBase {
  protected readonly ctx: unknown;
  protected readonly env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

const shim = { registered: false };

function registerCloudflareShim(): void {
  if (shim.registered) {
    return;
  }
  shim.registered = true;
  void mock.module('cloudflare:workers', () => ({ DurableObject: FakeDurableObjectBase }));
}

/**
 * The inert timer used while the module is not implemented (RED phase): every operation is a
 * no-op, so assertions on storage, alarms and attempts fail for the right reason.
 */
function inertTimerApi(): TimerApi {
  class InertFallbackTimer extends FakeDurableObjectBase implements FallbackTimerInstance {
    arm(_args: ArmArgs): Promise<void> {
      return Promise.resolve();
    }

    cancel(_id: string): Promise<void> {
      return Promise.resolve();
    }

    alarm(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    FallbackTimer: InertFallbackTimer,
    armTimer: () => Promise.resolve(),
    cancelTimer: () => Promise.resolve(),
  };
}

/**
 * Loads the timer API from `src/durable/fallback-timer.js` (class) and `src/core/timer.js`
 * (helpers), each falling back to the other and finally to the inert stubs.
 *
 * @returns The timer API to test against.
 */
export async function loadTimerApi(): Promise<TimerApi> {
  registerCloudflareShim();
  const inert = inertTimerApi();
  const candidates = ['../../src/durable/fallback-timer.js', '../../src/core/timer.js'];
  const loaded: Partial<TimerApi> = {};
  for (const specifier of candidates) {
    try {
      const mod = (await import(specifier)) as Partial<TimerApi>;
      loaded.FallbackTimer ??= mod.FallbackTimer;
      loaded.armTimer ??= mod.armTimer;
      loaded.cancelTimer ??= mod.cancelTimer;
    } catch {
      // not implemented yet (RED phase)
    }
  }
  const armTimer = loaded.armTimer ?? inert.armTimer;
  const cancelTimer = loaded.cancelTimer ?? inert.cancelTimer;
  return {
    FallbackTimer: loaded.FallbackTimer ?? inert.FallbackTimer,
    armTimer: (ns, args) => armTimer(ns, args),
    cancelTimer: (ns, id) => cancelTimer(ns, id),
  };
}

/**
 * Mocked clock: fixes `Date.now()` and fires due alarms when advanced.
 */
export interface FakeClock {
  now(): number;
  /**
   * Moves the clock forward and fires every alarm scheduled at or before the new time, in
   * order, awaiting each alarm handler.
   */
  advance(ms: number): Promise<void>;
  restore(): void;
}

/**
 * The key/value storage API of a Durable Object (the SQLite-backed KV surface).
 */
export interface FakeStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
  list<T = unknown>(): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
  sync(): Promise<void>;
  transaction<T>(closure: (txn: FakeStorage) => Promise<T>): Promise<T>;
  /**
   * Test-only snapshot of every stored entry.
   */
  dump(): Map<string, unknown>;
}

/**
 * The `DurableObjectState` handed to the class.
 */
export interface FakeDurableObjectState {
  id: { name: string; toString(): string; equals(other: unknown): boolean };
  storage: FakeStorage;
  waitUntil(promise: Promise<unknown>): void;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/**
 * One instantiated object in the fake namespace.
 */
export interface FakeObject {
  name: string;
  state: FakeDurableObjectState;
  instance: FallbackTimerInstance;
}

/**
 * A fake `DurableObjectNamespace` that instantiates the class in-process, one object per name,
 * and records every `idFromName` call.
 */
export interface FakeNamespace {
  namespace: DurableObjectNamespace;
  /**
   * Names passed to `idFromName`, in order.
   */
  idFromNameCalls: string[];
  /**
   * Objects created so far, keyed by name.
   */
  objects: Map<string, FakeObject>;
  /**
   * Every RPC call made through a stub: `[name, method]`.
   */
  calls: Array<{ name: string; method: 'arm' | 'cancel' | 'alarm'; args: unknown[] }>;
  /**
   * Storage snapshot of the object for `name` (empty when the object was never created).
   */
  storageOf(name: string): Map<string, unknown>;
  /**
   * Scheduled alarm of the object for `name`, or null.
   */
  alarmOf(name: string): Promise<number | null>;
}

interface Scheduled {
  name: string;
  at: number;
}

function createStorage(schedule: Scheduled[], name: string): FakeStorage {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;

  const setAlarm = (scheduledTime: number | Date): Promise<void> => {
    alarm = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
    const index = schedule.findIndex((s) => s.name === name);
    if (index !== -1) {
      schedule.splice(index, 1);
    }
    schedule.push({ name, at: alarm });
    return Promise.resolve();
  };

  const deleteAlarm = (): Promise<void> => {
    alarm = null;
    const index = schedule.findIndex((s) => s.name === name);
    if (index !== -1) {
      schedule.splice(index, 1);
    }
    return Promise.resolve();
  };

  const storage: FakeStorage = {
    get: ((keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        const out = new Map<string, unknown>();
        for (const key of keyOrKeys) {
          if (data.has(key)) {
            out.set(key, structuredClone(data.get(key)));
          }
        }
        return Promise.resolve(out);
      }
      return Promise.resolve(
        data.has(keyOrKeys) ? structuredClone(data.get(keyOrKeys)) : undefined
      );
    }) as FakeStorage['get'],
    put: ((keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') {
        data.set(keyOrEntries, structuredClone(value));
      } else {
        for (const [key, entry] of Object.entries(keyOrEntries)) {
          data.set(key, structuredClone(entry));
        }
      }
      return Promise.resolve();
    }),
    delete: ((keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        let count = 0;
        for (const key of keyOrKeys) {
          if (data.delete(key)) count++;
        }
        return Promise.resolve(count);
      }
      return Promise.resolve(data.delete(keyOrKeys));
    }) as FakeStorage['delete'],
    deleteAll: () => {
      data.clear();
      return Promise.resolve();
    },
    list: (() => Promise.resolve(new Map(data))) as FakeStorage['list'],
    setAlarm,
    getAlarm: () => Promise.resolve(alarm),
    deleteAlarm,
    sync: () => Promise.resolve(),
    transaction: (closure) => closure(storage),
    dump: () => new Map(data),
  };
  return storage;
}

/**
 * Creates a fake Durable Object runtime for `FallbackTimer`: a namespace that instantiates
 * the class per `idFromName`, and a mocked clock whose `advance` fires due alarms.
 *
 * @param FallbackTimer - The class to instantiate.
 * @param env - The env handed to each object (the same object the Worker sees).
 * @param startAt - The mocked "now" at creation.
 * @returns The namespace and the clock.
 */
export function createFakeDurableRuntime(
  FallbackTimer: FallbackTimerCtor,
  env: () => unknown,
  startAt: number
): { ns: FakeNamespace; clock: FakeClock } {
  let now = startAt;
  setSystemTime(new Date(now));

  const schedule: Scheduled[] = [];
  const objects = new Map<string, FakeObject>();
  const idFromNameCalls: string[] = [];
  const calls: FakeNamespace['calls'] = [];

  const objectFor = (name: string): FakeObject => {
    let object = objects.get(name);
    if (!object) {
      const state: FakeDurableObjectState = {
        id: {
          name,
          toString: () => `fake-id:${name}`,
          equals: (other: unknown) => String(other) === `fake-id:${name}`,
        },
        storage: createStorage(schedule, name),
        waitUntil: () => {},
        blockConcurrencyWhile: (callback) => callback(),
      };
      object = { name, state, instance: new FallbackTimer(state, env()) };
      objects.set(name, object);
    }
    return object;
  };

  const stubFor = (name: string): FallbackTimerInstance => ({
    arm: async (args) => {
      calls.push({ name, method: 'arm', args: [args] });
      await objectFor(name).instance.arm(args);
    },
    cancel: async (id) => {
      calls.push({ name, method: 'cancel', args: [id] });
      await objectFor(name).instance.cancel(id);
    },
    alarm: async () => {
      calls.push({ name, method: 'alarm', args: [] });
      await objectFor(name).instance.alarm();
    },
  });

  const namespace = {
    idFromName: (name: string) => {
      idFromNameCalls.push(name);
      return { name, toString: () => `fake-id:${name}` };
    },
    idFromString: (hex: string) => ({ name: hex, toString: () => `fake-id:${hex}` }),
    newUniqueId: () => {
      const name = `unique-${objects.size}-${idFromNameCalls.length}`;
      return { name, toString: () => `fake-id:${name}` };
    },
    get: (id: { name: string }) => stubFor(id.name),
    jurisdiction: () => namespace,
  } as unknown as DurableObjectNamespace;

  const fireDue = async (): Promise<void> => {
    // Alarms fire in scheduled order; an alarm handler may re-arm, so re-scan after each.
    for (;;) {
      const due = schedule.filter((s) => s.at <= now).toSorted((a, b) => a.at - b.at).at(0);
      if (due === undefined) {
        return;
      }
      schedule.splice(schedule.indexOf(due), 1);
      const object = objectFor(due.name);
      // The runtime clears the alarm before invoking the handler.
      await object.state.storage.deleteAlarm();
      calls.push({ name: due.name, method: 'alarm', args: [] });
      await object.instance.alarm();
    }
  };

  const clock: FakeClock = {
    now: () => now,
    advance: async (ms: number) => {
      now += ms;
      setSystemTime(new Date(now));
      await fireDue();
    },
    restore: () => {
      setSystemTime();
    },
  };

  const ns: FakeNamespace = {
    namespace,
    idFromNameCalls,
    objects,
    calls,
    storageOf: (name) => objects.get(name)?.state.storage.dump() ?? new Map(),
    alarmOf: (name) => objects.get(name)?.state.storage.getAlarm() ?? Promise.resolve(null),
  };

  return { ns, clock };
}

/**
 * A recorded outbound payload.
 */
export type RecordedPayload<R> = R & OutboundMeta;

/**
 * Provider that records every send and can be told to fail synchronously.
 */
export interface TimerTestProvider<R> extends Provider<R> {
  readonly calls: RecordedPayload<R>[];
  failNext(error: string): void;
}

/**
 * Creates a provider that records sends, assigns `providerId = "<name>_<n>"`, and accepts an
 * unsigned JSON webhook body `{ providerId, status, error? }` (or an array of them).
 *
 * @param name - Provider name.
 * @param channel - Channel served.
 * @returns The provider.
 */
export function timerTestProvider<R>(
  name: string,
  channel: Provider['channel']
): TimerTestProvider<R> {
  const calls: RecordedPayload<R>[] = [];
  const failures: string[] = [];
  return {
    name,
    channel,
    calls,
    failNext: (error: string) => {
      failures.push(error);
    },
    send: (message: R & OutboundMeta): Promise<SendResult> => {
      calls.push(message);
      const failure = failures.shift();
      if (failure !== undefined) {
        return Promise.resolve({ ok: false, error: failure });
      }
      return Promise.resolve({ ok: true, providerId: `${name}_${calls.length}` });
    },
    webhook: {
      parse: async (request: Request): Promise<StatusEvent[]> => {
        const body = (await request.json()) as
          Array<{ providerId: string; status: StatusEvent['status']; error?: string }> | { providerId: string; status: StatusEvent['status']; error?: string };
        const events = Array.isArray(body) ? body : [body];
        return events.map((e) => ({ ...e, at: new Date().toISOString() }));
      },
    },
  };
}

/**
 * Providers used by the timer specs: whatsapp and sms, both recording.
 */
export interface TimerProviders {
  whatsapp: TimerTestProvider<RenderedWhatsApp>;
  sms: TimerTestProvider<RenderedSms>;
}

/**
 * Creates a fresh whatsapp + sms provider pair.
 *
 * @returns The providers.
 */
export function timerProviders(): TimerProviders {
  return {
    whatsapp: timerTestProvider<RenderedWhatsApp>('wa', 'whatsapp'),
    sms: timerTestProvider<RenderedSms>('sms', 'sms'),
  };
}

/**
 * Template catalogue for the timer specs: an OTP template (whatsapp → sms) and a notification.
 */
export const timerTemplates = defineTemplates({
  loginCode: {
    kind: 'otp',
    whatsapp: {
      template: 'auth_code',
      language: 'en',
      params: (input: { code: string }) => [input.code],
    },
    sms: (input: { code: string }) => `Your code is ${input.code}`,
  },
  reminder: {
    kind: 'notification',
    whatsapp: { text: (input: { text: string }) => `Reminder: ${input.text}` },
    sms: (input: { text: string }) => `Reminder: ${input.text}`,
  },
});

/**
 * Builds a Worker env for the timer specs.
 *
 * @param kv - The status KV.
 * @param timer - The FALLBACK_TIMER namespace, or undefined for "binding absent".
 * @returns The env.
 */
export function timerEnv(
  kv: MessagingEnv['MESSAGES_KV'],
  timer?: DurableObjectNamespace
): MessagingEnv {
  return timer ? { MESSAGES_KV: kv, FALLBACK_TIMER: timer } : { MESSAGES_KV: kv };
}
