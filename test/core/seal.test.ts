/**
 * Encryption at rest for the render input (`src/core/seal.ts`) and the paths that depend on it:
 * key validation, a rotated key reaching the fallback path, and the webhook scrubber opening a
 * sealed stash.
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createMessaging, MessagingConfigError } from '../../src/core/messaging.js';
import {
  EncryptionKeyError,
  importSealKey,
  isSealed,
  openInput,
  sealInput,
  sealKeyProblem,
} from '../../src/core/seal.js';
import { validateEnv } from '../../src/env.js';
import type { RenderedSms } from '../../src/providers/types.js';
import { defineTemplates } from '../../src/templates.js';
import {
  captureConsole,
  memoryKV,
  pingTemplates,
  recordingProvider,
  TEST_ENC_KEY,
} from '../helpers/messaging.js';
import { timerProviders, timerTemplates } from '../helpers/timer.js';

const OTHER_KEY = btoa(String.fromCodePoint(...Array.from({ length: 32 }, (_, i) => 255 - i)));
const TO = '+14155550123';
const CODE = '482913';

function statusWebhook(providerId: string, error: string): Request {
  return new Request('https://worker.test/webhooks/wa', {
    method: 'POST',
    body: JSON.stringify({ providerId, status: 'failed', error }),
  });
}

describe('sealInput / openInput', () => {
  it('round-trips an input and never carries it in the clear', async () => {
    const key = await importSealKey(TEST_ENC_KEY);
    const sealed = await sealInput(key, { id: 'msg_1' }, { code: CODE });

    expect(isSealed(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(CODE);
    expect(await openInput(key, { id: 'msg_1' }, sealed)).toEqual({
      ok: true,
      input: { code: CODE },
    });
  });

  it('uses a fresh IV per seal', async () => {
    const key = await importSealKey(TEST_ENC_KEY);
    const a = await sealInput(key, { id: 'msg_1' }, { code: CODE });
    const b = await sealInput(key, { id: 'msg_1' }, { code: CODE });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('refuses an envelope opened under another message id (bound as additional data)', async () => {
    const key = await importSealKey(TEST_ENC_KEY);
    const sealed = await sealInput(key, { id: 'msg_1' }, { code: CODE });
    expect(await openInput(key, { id: 'msg_2' }, sealed)).toEqual({ ok: false });
  });

  it('refuses an envelope whose recipient or locale was rewritten beside it', async () => {
    const key = await importSealKey(TEST_ENC_KEY);
    const context = { id: 'msg_1', to: TO, locale: 'en' };
    const sealed = await sealInput(key, context, { code: CODE });

    expect(await openInput(key, context, sealed)).toEqual({ ok: true, input: { code: CODE } });
    expect(await openInput(key, { ...context, to: '+19995550100' }, sealed)).toEqual({
      ok: false,
    });
    expect(await openInput(key, { ...context, locale: 'si' }, sealed)).toEqual({ ok: false });
    expect(await openInput(key, { ...context, email: 'x@example.com' }, sealed)).toEqual({
      ok: false,
    });
  });

  it('refuses an envelope under a different key, or with no key', async () => {
    const sealed = await sealInput(
      await importSealKey(TEST_ENC_KEY),
      { id: 'msg_1' },
      { code: CODE }
    );
    expect(await openInput(await importSealKey(OTHER_KEY), { id: 'msg_1' }, sealed)).toEqual({
      ok: false,
    });
    expect(await openInput(undefined, { id: 'msg_1' }, sealed)).toEqual({ ok: false });
  });

  it('passes an unsealed value through, and seals nothing without a key', async () => {
    expect(await openInput(undefined, { id: 'msg_1' }, { code: CODE })).toEqual({
      ok: true,
      input: { code: CODE },
    });
    expect(await sealInput(undefined, { id: 'msg_1' }, { code: CODE })).toEqual({ code: CODE });
  });
});

describe('seal key validation', () => {
  it.each([
    ['empty', ''],
    ['whitespace', ' '.repeat(3)],
    ['not base64', '%%%not-base64%%%'],
    ['16 bytes', btoa('0123456789abcdef')],
    ['not a string', 42],
  ])('reports a %s key', (_label, raw) => {
    expect(sealKeyProblem(raw)).toBeString();
  });

  it('accepts a 32-byte base64 key', () => {
    expect(sealKeyProblem(TEST_ENC_KEY)).toBeUndefined();
  });

  it('importSealKey rejects a malformed key with EncryptionKeyError', async () => {
    let caught: unknown;
    try {
      await importSealKey(btoa('short'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EncryptionKeyError);
  });

  it('createMessaging refuses a malformed key even for a catalogue with no otp template', () => {
    expect(() =>
      createMessaging(
        { MESSAGES_KV: memoryKV(), MESSAGES_ENC_KEY: btoa('short') },
        { templates: pingTemplates, providers: () => ({}) }
      )
    ).toThrow(MessagingConfigError);
  });

  it('validateEnv reports a missing key for an otp catalogue and a malformed one for any', () => {
    const otp = defineTemplates({
      code: {
        input: z.object({ code: z.string() }),
        kind: 'otp',
        sms: ({ code }: { code: string }) => code,
      },
    });
    const sms = recordingProvider<RenderedSms>('sms', 'sms');
    expect(() =>
      validateEnv({ MESSAGES_KV: memoryKV() }, { templates: otp, providers: () => ({ sms }) })
    ).toThrow(/Missing required secret MESSAGES_ENC_KEY/);
    expect(() =>
      validateEnv(
        { MESSAGES_KV: memoryKV(), MESSAGES_ENC_KEY: btoa('short') },
        { templates: pingTemplates, providers: () => ({ sms }) }
      )
    ).toThrow(/MESSAGES_ENC_KEY must decode to 32 bytes/);
  });
});

describe('a seal that fails at send time', () => {
  it('writes neither in:<id> nor the timer, logs send.seal-failed, and still dispatches', async () => {
    const kv = memoryKV();
    const armed: string[] = [];
    const providers = timerProviders();
    const messaging = createMessaging(
      { MESSAGES_KV: kv, MESSAGES_ENC_KEY: TEST_ENC_KEY },
      {
        templates: timerTemplates,
        providers: () => ({ whatsapp: providers.whatsapp, sms: providers.sms }),
        timer: {
          idFromName: (name: string) => ({ name }),
          get: () => ({
            arm: (args: { id: string }) => {
              armed.push(args.id);
              return Promise.resolve();
            },
            cancel: () => Promise.resolve(),
          }),
        } as unknown as DurableObjectNamespace,
      }
    );
    const encrypt = spyOn(crypto.subtle, 'encrypt').mockRejectedValue(new Error('crypto fault'));
    const { logs, restore } = captureConsole();
    const sending = messaging.send({
      template: 'loginCode',
      to: TO,
      locale: 'en',
      input: { code: CODE },
    });
    const settled = await Promise.allSettled([sending]);
    restore();
    encrypt.mockRestore();
    const [outcome] = settled;
    if (outcome.status === 'rejected') throw outcome.reason;
    const { id } = outcome.value;

    expect(kv.dump().has(`in:${id}`)).toBe(false);
    expect(armed).toHaveLength(0);
    expect(logs.some((line) => line.includes('send.seal-failed'))).toBe(true);
    expect(JSON.stringify(kv.dump().values().toArray())).not.toContain(CODE);
    expect(providers.whatsapp.calls).toHaveLength(1);
  });
});

describe('a sealed stash on the asynchronous paths', () => {
  it('records the next channel failed and logs fallback.input-unsealable after a key rotation', async () => {
    const kv = memoryKV();
    const providers = timerProviders();
    const options = {
      templates: timerTemplates,
      providers: () => ({ whatsapp: providers.whatsapp, sms: providers.sms }),
    };
    const before = createMessaging({ MESSAGES_KV: kv, MESSAGES_ENC_KEY: TEST_ENC_KEY }, options);
    const { id } = await before.send({
      template: 'loginCode',
      to: TO,
      locale: 'en',
      input: { code: CODE },
    });

    // The key is rotated while the chain is in flight.
    const after = createMessaging({ MESSAGES_KV: kv, MESSAGES_ENC_KEY: OTHER_KEY }, options);
    const { logs, restore } = captureConsole();
    try {
      const response = await after.handleWebhook('wa', statusWebhook('wa_1', 'undeliverable'));
      expect(response.status).toBe(200);
    } finally {
      restore();
    }

    expect(providers.sms.calls).toHaveLength(0);
    const record = await after.status(id);
    expect(record?.chain.attempts.at(1)).toMatchObject({ channel: 'sms', status: 'failed' });
    expect(record?.chain.attempts.at(1)?.error).toContain('could not be decrypted');
    expect(record?.chain.status).toBe('failed');
    expect(logs.some((line) => line.includes('fallback.input-unsealable'))).toBe(true);
    expect(logs.join('\n')).not.toContain(CODE);
  });

  it('does not send the code to a recipient rewritten in in:<id>', async () => {
    const kv = memoryKV();
    const providers = timerProviders();
    const messaging = createMessaging(
      { MESSAGES_KV: kv, MESSAGES_ENC_KEY: TEST_ENC_KEY },
      {
        templates: timerTemplates,
        providers: () => ({ whatsapp: providers.whatsapp, sms: providers.sms }),
      }
    );
    const { id } = await messaging.send({
      template: 'loginCode',
      to: TO,
      locale: 'en',
      input: { code: CODE },
    });

    // Someone with KV write access but not the key points the fallback at their own number.
    const stash = JSON.parse((await kv.get(`in:${id}`)) ?? '{}') as Record<string, unknown>;
    await kv.put(`in:${id}`, JSON.stringify({ ...stash, to: '+19995550100' }));
    await messaging.handleWebhook('wa', statusWebhook('wa_1', 'undeliverable'));

    expect(providers.sms.calls).toHaveLength(0);
    const record = await messaging.status(id);
    expect(record?.chain.attempts.at(1)?.error).toContain('could not be decrypted');
  });

  it('scrubs a notification webhook error against the sealed stash', async () => {
    const kv = memoryKV();
    const providers = timerProviders();
    const secret = 'pickup at gate seven';
    const messaging = createMessaging(
      { MESSAGES_KV: kv, MESSAGES_ENC_KEY: TEST_ENC_KEY },
      {
        templates: timerTemplates,
        providers: () => ({ whatsapp: providers.whatsapp, sms: providers.sms }),
      }
    );
    const { id } = await messaging.send({
      template: 'reminder',
      to: TO,
      locale: 'en',
      input: { text: secret },
    });

    // The error quotes the bare input, not the rendered "Reminder: ..." text, so only the
    // opened stash can recognise it.
    await messaging.handleWebhook('wa', statusWebhook('wa_1', `Rejected "${secret}" as spam`));

    const record = await messaging.status(id);
    const error = record?.chain.attempts.at(0)?.error ?? '';
    expect(error).not.toContain(secret);
    expect(error).toContain('[redacted]');
    expect(error).toContain('as spam');
  });
});
