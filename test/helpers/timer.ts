/**
 * Test helpers for the FallbackTimer Durable Object (Issue #8).
 *
 * Provides:
 * - a fake Durable Object runtime (state + storage + namespace) driven by a mocked clock, so
 *   the arm → timeout → alarm → cleanup lifecycle can be exercised in-process against a local
 *   status store, with no Worker or wrangler involved (`FallbackTimer` resolves its base class
 *   to a stand-in outside workerd, so the real class is instantiated directly);
 * - recording providers and a template catalogue shared by the timer specs.
 *
 * @module
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, it, setSystemTime } from 'bun:test';

import type { ArmTimerArgs } from '../../src/core/timer.js';
import type { FallbackTimer } from '../../src/durable/fallback-timer.js';
import type { MessagingEnv } from '../../src/env.js';
import type {
  OutboundMeta,
  Provider,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
} from '../../src/providers/types.js';
import { parseStatusEvents } from '../durable/fixtures/timer-catalogue.js';

export { timerTemplates } from '../durable/fixtures/timer-catalogue.js';

/**
 * The public surface of a FallbackTimer instance (RPC methods). `ArmTimerArgs` is the issue's
 * literal interface plus the optional `to` / `email` of a render input; the specs arm with the
 * literal shape and rely on the `in:<id>` KV entry `send` writes (#7) for the recipient.
 */
export interface FallbackTimerInstance {
  arm(args: ArmTimerArgs): Promise<void>;
  cancel(id: string): Promise<void>;
  alarm(): Promise<void>;
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
 * A row cursor in the shape of workerd's `SqlStorageCursor`.
 */
export interface FakeSqlCursor<Row> extends Iterable<Row> {
  columnNames: string[];
  rowsRead: number;
  rowsWritten: number;
  toArray(): Row[];
  one(): Row;
  raw(): unknown[][];
}

/**
 * The `ctx.storage.sql` surface, backed by an in-memory `bun:sqlite` database.
 */
export interface FakeSqlStorage {
  exec<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): FakeSqlCursor<Row>;
  databaseSize: number;
}

/**
 * The storage API of a SQLite-backed Durable Object: the key/value surface plus `sql`.
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
  transactionSync<T>(closure: () => T): T;
  sql: FakeSqlStorage;
  /**
   * Test-only snapshot of everything stored on either surface: every key/value entry, plus
   * one `sql:<table>` entry (its rows) for every user table that has rows.
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

const SQL_PLACEHOLDER = /\?|:\w+|\$\w+|@\w+/;

/**
 * Rows of every user table (internal `_cf_*` / `sqlite_*` tables excluded), by table name.
 */
function userTables(db: Database): Map<string, Record<string, unknown>[]> {
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .filter((tableName) => !tableName.startsWith('_cf_') && !tableName.startsWith('sqlite_'));
  const out = new Map<string, Record<string, unknown>[]>();
  for (const tableName of names) {
    out.set(tableName, db.query<Record<string, unknown>, []>(`SELECT * FROM "${tableName}"`).all());
  }
  return out;
}

function createSql(db: Database): FakeSqlStorage {
  return {
    exec<Row extends Record<string, unknown> = Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): FakeSqlCursor<Row> {
      const statements = query
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      let rows: Row[] = [];
      let columnNames: string[] = [];
      let rowsWritten = 0;
      for (const statement of statements) {
        const prepared = db.prepare<Row, SQLQueryBindings[]>(statement);
        const before = db.query<{ n: number }, []>('SELECT total_changes() AS n').get()?.n ?? 0;
        const args = SQL_PLACEHOLDER.test(statement) ? (bindings as SQLQueryBindings[]) : [];
        rows = prepared.all(...args);
        columnNames = prepared.columnNames;
        const after = db.query<{ n: number }, []>('SELECT total_changes() AS n').get()?.n ?? 0;
        rowsWritten += after - before;
      }
      return {
        columnNames,
        rowsRead: rows.length,
        rowsWritten,
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) {
            throw new Error(`Expected exactly one result, got ${rows.length}`);
          }
          return rows[0];
        },
        raw: () => rows.map((row) => columnNames.map((column) => Reflect.get(row, column))),
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
    databaseSize: 0,
  };
}

function createStorage(schedule: Scheduled[], name: string): FakeStorage {
  const data = new Map<string, unknown>();
  const db = new Database(':memory:');
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
    put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') {
        data.set(keyOrEntries, structuredClone(value));
      } else {
        for (const [key, entry] of Object.entries(keyOrEntries)) {
          data.set(key, structuredClone(entry));
        }
      }
      return Promise.resolve();
    },
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
      for (const tableName of userTables(db).keys()) {
        db.run(`DROP TABLE IF EXISTS "${tableName}"`);
      }
      return Promise.resolve();
    },
    list: (() => Promise.resolve(new Map(data))) as FakeStorage['list'],
    setAlarm,
    getAlarm: () => Promise.resolve(alarm),
    deleteAlarm,
    sync: () => Promise.resolve(),
    transaction: (closure) => closure(storage),
    transactionSync: (closure) => closure(),
    sql: createSql(db),
    dump: () => {
      const snapshot = new Map<string, unknown>(data);
      for (const [tableName, rows] of userTables(db)) {
        if (rows.length > 0) {
          snapshot.set(`sql:${tableName}`, rows);
        }
      }
      return snapshot;
    },
  };
  return storage;
}

/**
 * Creates a fake Durable Object runtime for `FallbackTimer`: a namespace that instantiates
 * the class per `idFromName`, and a mocked clock whose `advance` fires due alarms.
 *
 * @param Timer - The class to instantiate.
 * @param env - The env handed to each object (the same object the Worker sees).
 * @param startAt - The mocked "now" at creation.
 * @returns The namespace and the clock.
 */
export function createFakeDurableRuntime(
  Timer: typeof FallbackTimer,
  env: () => MessagingEnv,
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
      // The fake state covers what the object uses (storage, alarms, id); the cast (to the global
      // DurableObjectState the class is declared against) is the boundary between the two.
      const instance = new Timer(state as unknown as DurableObjectState, env());
      object = { name, state, instance };
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
      const due = schedule
        .filter((s) => s.at <= now)
        .toSorted((a, b) => a.at - b.at)
        .at(0);
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
    webhook: { parse: parseStatusEvents },
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

/**
 * Self-test (AGENTS.md, "Shared test fixtures/helpers under `test/helpers/`"): a helper file with
 * no `describe` of its own never shows up in the runner's output, which makes it look like a
 * red-phase test that silently failed to run. This runs with whichever spec imports the helper.
 */
describe('test/helpers/timer', () => {
  it('loads', () => {
    expect(typeof createFakeDurableRuntime).toBe('function');
    expect(typeof timerProviders).toBe('function');
    expect(typeof timerEnv).toBe('function');
    const provider = timerTestProvider<RenderedSms>('self-test-sms', 'sms');
    expect(provider.name).toBe('self-test-sms');
  });
});
