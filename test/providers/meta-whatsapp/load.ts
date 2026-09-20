/**
 * Loader for the meta-whatsapp provider under test (Issue #4).
 *
 * The provider module is imported dynamically so that, while it does not yet
 * exist, every test still fails on its own assertion rather than on a
 * module-resolution error. When the import fails a deliberately wrong
 * placeholder is returned: it never calls fetch, never succeeds, answers every
 * handshake with a 500, and always parses to a sentinel event, so no test in
 * this directory can pass against it.
 */

import type { Provider, RenderedWhatsApp } from '../../../src/providers/types.js';

/**
 * Configuration accepted by `metaWhatsApp()` as specified in Issue #4.
 */
export interface MetaWhatsAppConfig {
  token: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  apiVersion?: string;
  name?: string;
}

export type MetaWhatsAppFactory = (config: MetaWhatsAppConfig) => Provider<RenderedWhatsApp>;

const MODULE_PATH = '../../../src/providers/meta-whatsapp/index.js';

function placeholderProvider(): Provider<RenderedWhatsApp> {
  return {
    name: 'placeholder',
    channel: 'sms',
    send: () => Promise.resolve({ ok: false, error: 'meta-whatsapp provider not implemented' }),
    webhook: {
      verify: () => Promise.resolve(new Response('placeholder', { status: 500 })),
      parse: () =>
        Promise.resolve([
          { providerId: 'placeholder', status: 'failed' as const, at: 'placeholder' },
        ]),
    },
  };
}

/**
 * Load the `metaWhatsApp` factory from `src/providers/meta-whatsapp`.
 */
export async function loadMetaWhatsApp(): Promise<MetaWhatsAppFactory> {
  try {
    const mod = (await import(MODULE_PATH)) as { metaWhatsApp?: unknown };
    if (typeof mod.metaWhatsApp === 'function') {
      return mod.metaWhatsApp as MetaWhatsAppFactory;
    }
    return placeholderProvider;
  } catch {
    return placeholderProvider;
  }
}

/**
 * Standard configuration used across the meta-whatsapp tests.
 */
export const testConfig: MetaWhatsAppConfig = {
  token: 'EAAB-test-token',
  phoneNumberId: '123456789012345',
  appSecret: 'app-secret-for-tests',
  verifyToken: 'verify-token-for-tests',
};

/**
 * Compute `sha256=<hex>` for `body` with `secret` using Web Crypto, the same
 * way Meta signs `X-Hub-Signature-256`.
 */
export async function signBody(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

/**
 * Await `promise` and return the error it rejected with, or `undefined` if it
 * resolved. Lets a test assert on rejection without `await expect(...).rejects`.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}
