/**
 * Tests for MessagingEnv and validateEnv startup validation (Issue #13).
 *
 * Acceptance criteria:
 * - A missing MESSAGES_KV fails tsc when the Worker is typed with MessagingEnv, and at runtime
 *   produces a single error whose message lists both a missing binding and a duplicate provider
 *   name when both are wrong.
 * - validateEnv collects ALL problems (missing MESSAGES_KV AND a duplicate provider name in one
 *   test) into a single thrown error listing all of them with a bullet per problem, not just the first.
 * - validateEnv checks MESSAGES_KV is present, FALLBACK_TIMER is a namespace when present, the
 *   default delivery policy is well-formed, every template passes definition-time validation, and
 *   every providers(env) slot is a Provider with a unique name.
 */

import type { DurableObjectNamespace, KVNamespace } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';

import type { MessagingOptions } from '../src/core/messaging.js';
import { type MessagingEnv, validateEnv } from '../src/env.js';
import type { Channel, Provider } from '../src/providers/types.js';
import type { Templates } from '../src/templates.js';
import { memoryKV, pingTemplates } from './helpers/messaging.js';

// Type-level assertion helpers
type Extends<A, B> = A extends B ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type Expect<T extends true> = T;

function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

describe('MessagingEnv type-level specification (Issue #13)', () => {
  it('enforces MESSAGES_KV as a required KVNamespace on MessagingEnv', () => {
    // Valid MessagingEnv with MESSAGES_KV
    type ValidEnv = {
      MESSAGES_KV: KVNamespace;
    };
    type TestValidEnv = Expect<Extends<ValidEnv, MessagingEnv>>;
    assertType<TestValidEnv>(true);

    // Missing MESSAGES_KV must fail type check
    type MissingKVEnv = {
      OTHER_BINDING: string;
    };
    type TestMissingKVFails = Expect<Not<Extends<MissingKVEnv, MessagingEnv>>>;
    assertType<TestMissingKVFails>(true);

    // Optional FALLBACK_TIMER and MESSAGING_DEV_UNSIGNED
    type FullEnv = {
      MESSAGES_KV: KVNamespace;
      FALLBACK_TIMER?: DurableObjectNamespace;
      MESSAGING_DEV_UNSIGNED?: string;
      CUSTOM_SECRET: string;
    };
    type TestFullEnv = Expect<Extends<FullEnv, MessagingEnv>>;
    assertType<TestFullEnv>(true);

    const testInstance: MessagingEnv = { MESSAGES_KV: memoryKV() };
    expect(testInstance.MESSAGES_KV).toBeDefined();
  });
});

describe('validateEnv startup validation (Issue #13)', () => {
  it('passes on a valid environment and well-formed options', () => {
    const env: MessagingEnv = {
      MESSAGES_KV: memoryKV(),
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
      delivery: {
        fallback: ['sms' as const],
        always: [],
      },
    };

    expect(() => validateEnv(env, options)).not.toThrow();
  });

  it('throws an error when MESSAGES_KV is missing from env', () => {
    const env = {};

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
    };

    expect(() => validateEnv(env, options)).toThrow(/MESSAGES_KV/);
  });

  it('throws an error when MESSAGES_KV is not a valid KVNamespace', () => {
    const env = {
      MESSAGES_KV: 'not-a-kv-namespace',
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
    };

    expect(() => validateEnv(env, options)).toThrow(/MESSAGES_KV/);
  });

  it('throws an error when FALLBACK_TIMER is present but not a namespace', () => {
    const env = {
      MESSAGES_KV: memoryKV(),
      FALLBACK_TIMER: 'invalid-timer-namespace',
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
    };

    expect(() => validateEnv(env, options)).toThrow(/FALLBACK_TIMER/);
  });

  // `resolveTimer` only adapts a binding with both `idFromName` and `get`; anything else comes
  // back as a client with no `arm`/`cancel`, which turns timed fallback off in silence. Startup
  // validation shares that one predicate, so a KV namespace wired to the wrong binding is a
  // loud configuration fault instead.
  it('throws an error when FALLBACK_TIMER is a KV namespace rather than a Durable Object one', () => {
    const env = {
      MESSAGES_KV: memoryKV(),
      FALLBACK_TIMER: memoryKV(),
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
    };

    expect(() => validateEnv(env, options)).toThrow(/FALLBACK_TIMER/);
  });

  it('throws an error when default delivery policy is malformed', () => {
    const env: MessagingEnv = {
      MESSAGES_KV: memoryKV(),
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
      delivery: {
        fallback: ['unknown_channel' as Channel],
        always: [],
      },
    };

    expect(() => validateEnv(env, options)).toThrow(/delivery/i);
  });

  // The failure messages ARE this module's product: a regression in any of them turns a loud
  // startup failure into a silent misconfiguration, so each branch asserts its own fragment
  // rather than sharing one broad `/delivery/i`.
  it.each([
    ['fallback is not an array', { fallback: 'sms' }, /fallback must be an array/],
    ['always is not an array', { always: 'sms' }, /always must be an array/],
    ['timeout is not an object', { timeout: 30_000 }, /timeout must be an object/],
    ['timeout.otp is not a number', { timeout: { otp: '30s' } }, /timeout\.otp must be a number/],
    [
      'timeout.notification is not a number',
      { timeout: { notification: NaN } },
      /timeout\.notification must be a number/,
    ],
  ])('reports the specific problem when %s', (_label, delivery, expected) => {
    const env: MessagingEnv = {
      MESSAGES_KV: memoryKV(),
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
      delivery,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as MessagingOptions<any>;

    expect(() => validateEnv(env, options)).toThrow(expected);
  });

  it.each([
    ['providers is not a function', 'not-a-function', /providers option must be a function/],
    [
      'the providers function throws while being evaluated',
      () => {
        throw new Error('secret binding missing');
      },
      /providers function threw an error during evaluation: secret binding missing/,
    ],
    [
      'the providers function returns a non-object',
      () => 'not-a-provider-set',
      /providers function must return an object/,
    ],
  ])('reports the specific problem when %s', (_label, providers, expected) => {
    const env: MessagingEnv = {
      MESSAGES_KV: memoryKV(),
    };

    const options = {
      templates: pingTemplates,
      providers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as MessagingOptions<any>;

    expect(() => validateEnv(env, options)).toThrow(expected);
  });

  it('throws an error when a template fails definition-time validation', () => {
    const env: MessagingEnv = {
      MESSAGES_KV: memoryKV(),
    };

    // Construct raw template object with invalid delivery referencing unrendered whatsapp channel
    const invalidTemplates = {
      brokenDelivery: {
        kind: 'notification',
        sms: () => 'broken',
        delivery: {
          fallback: ['whatsapp'],
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as Templates<any>;

    const options = {
      templates: invalidTemplates,
      providers: () => ({
        sms: {
          name: 'valid-sms',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
    };

    expect(() => validateEnv(env, options)).toThrow(/brokenDelivery/);
  });

  it('throws an error when a provider slot is invalid or missing required fields', () => {
    const env: MessagingEnv = {
      MESSAGES_KV: memoryKV(),
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({ sms: { name: 'incomplete-provider' } as unknown as Provider }),
    };

    expect(() => validateEnv(env, options)).toThrow(/missing required field/i);
  });

  it('throws an error when duplicate provider names are configured across slots', () => {
    const env: MessagingEnv = {
      MESSAGES_KV: memoryKV(),
    };

    const duplicateProvider: Provider = {
      name: 'shared-provider-name',
      channel: 'sms',
      send: () => Promise.resolve({ ok: true }),
    };
    const duplicateWhatsApp: Provider = {
      name: 'shared-provider-name',
      channel: 'whatsapp',
      send: () => Promise.resolve({ ok: true }),
    };

    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: duplicateProvider,
        whatsapp: duplicateWhatsApp,
      }),
    };

    expect(() => validateEnv(env, options)).toThrow(/duplicate provider name/i);
  });

  it('collects ALL problems into a single thrown error listing missing MESSAGES_KV and duplicate provider name', () => {
    // Missing MESSAGES_KV entirely
    const env = {};

    // Duplicate provider names across channels
    const options = {
      templates: pingTemplates,
      providers: () => ({
        sms: {
          name: 'duplicate-vendor',
          channel: 'sms' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
        whatsapp: {
          name: 'duplicate-vendor',
          channel: 'whatsapp' as const,
          send: () => Promise.resolve({ ok: true as const }),
        },
      }),
    };

    let thrownError: Error | null = null;
    try {
      validateEnv(env, options);
    } catch (err: unknown) {
      thrownError = err as Error;
    }

    expect(thrownError).not.toBeNull();
    expect(thrownError).toBeInstanceOf(Error);

    const message = thrownError?.message ?? '';
    // Must list both problems in one error message with bullet formatting
    expect(message).toContain('MESSAGES_KV');
    expect(message.toLowerCase()).toContain('duplicate-vendor');
    expect(message).toMatch(/^- /m);
  });
});
