/**
 * Shared fixtures and helpers for the meta-whatsapp provider tests (Issue #4).
 */

import type { MetaWhatsAppConfig } from '../../../src/providers/meta-whatsapp/index.js';

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
    ['sign']
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
