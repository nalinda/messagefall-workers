/**
 * Unit tests for delivery policy resolution.
 */

import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_POLICY,
  type DeliveryPolicy,
  PolicyError,
  resolveDelivery,
} from '../../src/core/policy.js';

describe('resolveDelivery', () => {
  const defaults: DeliveryPolicy = {
    fallback: ['whatsapp', 'sms'],
    always: [],
  };

  it('resolves with defaults only', () => {
    const result = resolveDelivery({
      defaults,
      defined: ['whatsapp', 'sms'],
    });

    expect(result).toEqual({
      fallback: ['whatsapp', 'sms'],
      always: [],
    });
  });

  it('inherits fallback from defaults when template sets always only', () => {
    const result = resolveDelivery({
      defaults,
      template: { always: ['email'] },
      defined: ['whatsapp', 'sms', 'email'],
    });

    expect(result).toEqual({
      fallback: ['whatsapp', 'sms'],
      always: ['email'],
    });
  });

  it('inherits always from template when send sets fallback only', () => {
    const result = resolveDelivery({
      defaults,
      template: { always: ['email'] },
      send: { fallback: ['sms'] },
      defined: ['whatsapp', 'sms', 'email'],
    });

    expect(result).toEqual({
      fallback: ['sms'],
      always: ['email'],
    });
  });

  it('resolves "all" at template level to all defined channels in always and empty fallback', () => {
    const result = resolveDelivery({
      defaults,
      template: 'all',
      defined: ['whatsapp', 'sms', 'email'],
    });

    expect(result).toEqual({
      fallback: [],
      always: ['whatsapp', 'sms', 'email'],
    });
  });

  it('resolves "all" at send level overriding a template fallback', () => {
    const result = resolveDelivery({
      defaults,
      template: { fallback: ['sms'] },
      send: 'all',
      defined: ['whatsapp', 'sms'],
    });

    expect(result).toEqual({
      fallback: [],
      always: ['whatsapp', 'sms'],
    });
  });

  it('removes a channel from fallback if it is present in always', () => {
    const result = resolveDelivery({
      defaults: {
        fallback: ['whatsapp', 'sms'],
        always: ['whatsapp'],
      },
      defined: ['whatsapp', 'sms'],
    });

    expect(result).toEqual({
      fallback: ['sms'],
      always: ['whatsapp'],
    });
  });

  it('drops channels not in defined while preserving defined channel order', () => {
    const result = resolveDelivery({
      defaults: {
        fallback: ['whatsapp', 'sms'],
        always: [],
      },
      defined: ['sms'],
    });

    expect(result).toEqual({
      fallback: ['sms'],
      always: [],
    });
  });

  it('throws PolicyError when template defines nothing in the resolved policy', () => {
    let error: PolicyError | undefined;
    try {
      resolveDelivery({
        defaults: {
          fallback: ['whatsapp'],
          always: [],
        },
        defined: ['sms'],
        templateName: 'loginCode',
      });
    } catch (err) {
      if (err instanceof PolicyError) {
        error = err;
      }
    }

    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(PolicyError);
    expect(error?.name).toBe('PolicyError');
    expect(error?.templateName).toBe('loginCode');
    expect(error?.defaults).toEqual({ fallback: ['whatsapp'], always: [] });
    expect(error?.template).toBeUndefined();
    expect(error?.send).toBeUndefined();
    expect(error?.defined).toEqual(['sms']);
    expect(error?.beforeFilter).toEqual({ fallback: ['whatsapp'], always: [] });
    expect(error?.message).toContain('loginCode');
    expect(error?.message).toContain('sms');
  });

  it('throws PolicyError with unnamed label if templateName is omitted', () => {
    expect(() =>
      resolveDelivery({
        defaults: { fallback: ['whatsapp'], always: [] },
        defined: ['sms'],
      })
    ).toThrow(PolicyError);
  });

  it('allows send level to override with empty always array', () => {
    const result = resolveDelivery({
      defaults,
      template: { always: ['email'] },
      send: { always: [] },
      defined: ['whatsapp', 'sms', 'email'],
    });

    expect(result).toEqual({
      fallback: ['whatsapp', 'sms'],
      always: [],
    });
  });

  it('allows send level to override fallback with empty array', () => {
    const result = resolveDelivery({
      defaults,
      send: { fallback: [], always: ['email'] },
      defined: ['whatsapp', 'sms', 'email'],
    });

    expect(result).toEqual({
      fallback: [],
      always: ['email'],
    });
  });

  it('allows send level fallback override when template is "all"', () => {
    const result = resolveDelivery({
      defaults,
      template: 'all',
      send: { fallback: ['sms'], always: ['email'] },
      defined: ['whatsapp', 'sms', 'email'],
    });

    expect(result).toEqual({
      fallback: ['sms'],
      always: ['email'],
    });
  });

  it('deduplicates duplicate entries within fallback or always', () => {
    const result = resolveDelivery({
      defaults: {
        fallback: ['whatsapp', 'whatsapp', 'sms'],
        always: ['email', 'email'],
      },
      defined: ['whatsapp', 'sms', 'email'],
    });

    expect(result).toEqual({
      fallback: ['whatsapp', 'sms'],
      always: ['email'],
    });
  });

  it('preserves fallback order specified in policy', () => {
    const result = resolveDelivery({
      defaults: {
        fallback: ['sms', 'whatsapp', 'email'],
        always: [],
      },
      defined: ['email', 'sms', 'whatsapp'],
    });

    expect(result).toEqual({
      fallback: ['sms', 'whatsapp', 'email'],
      always: [],
    });
  });

  it('DEFAULT_POLICY provides whatsapp -> sms with empty always', () => {
    expect(DEFAULT_POLICY).toEqual({
      fallback: ['whatsapp', 'sms'],
      always: [],
    });
  });
});
