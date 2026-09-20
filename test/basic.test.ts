/**
 * Basic tests for messagefall-workers.
 *
 * These tests verify the core functionality works as expected.
 */

import { describe, expect, it } from 'bun:test';

import { createMessaging, defineTemplates } from '../src';
import { createMockKV,createTestState } from './helpers';

describe('createMessaging', () => {
  it('creates a messaging state with stub provider', () => {
    const config = {
      kv: createMockKV(),
      providers: [
        {
          id: 'stub',
          config: {},
          state: { kv: {} },
        },
      ],
    };

    const state = createMessaging(config);

    expect(state).toBeDefined();
    expect(state.providers.size).toBe(1);
  });

  it('registers the stub provider', () => {
    const config = {
      kv: createMockKV(),
      providers: [
        {
          id: 'stub',
          config: {},
          state: { kv: {} },
        },
      ],
    };

    const state = createMessaging(config);
    const provider = state.providers.get('stub');

    expect(provider).toBeDefined();
    expect(provider?.id).toBe('stub');
    expect(provider?.channel).toBe('whatsapp');
  });
});

describe('defineTemplates', () => {
  it('adds templates to the registry', () => {
    const state = createTestState();

    const templates = [
      { id: 'otp', kind: 'otp', inputSchema: {}, renderings: [] },
      { id: 'text', kind: 'text', inputSchema: {}, renderings: [] },
    ];

    defineTemplates(templates);

    expect(state.templates.get('otp')).toBeDefined();
    expect(state.templates.get('text')).toBeDefined();
  });
});
