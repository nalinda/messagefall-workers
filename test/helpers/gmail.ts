/**
 * Test helpers and type mirrors for Gmail provider specifications (Issue #20).
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import type { Provider, RenderedEmail } from '../../src/providers/types.js';

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  from: string;
  name?: string;
  tokenCache?: KVNamespace;
}

export type GmailProviderFactory = (c: GmailConfig) => Provider<RenderedEmail>;

export interface MimeMessageOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  date?: Date;
}

export type BuildMimeMessageFn = (options: MimeMessageOptions) => string;

const dummySend = async () => {
  await Promise.resolve();
  return { ok: false, error: 'Gmail provider not implemented', retryable: false } as const;
};

const dummyGmailFactory: GmailProviderFactory = (config: GmailConfig): Provider<RenderedEmail> => ({
  name: config.name ?? 'gmail',
  channel: 'email',
  send: dummySend,
});

const dummyMimeBuilder: BuildMimeMessageFn = (_options: MimeMessageOptions): string => '';

/**
 * Dynamically loads the gmail provider factory from src/providers/gmail/index.js if implemented,
 * or falls back to a stub in the RED phase so tests execute real assertions and fail for the right reason.
 */
export async function loadGmail(): Promise<GmailProviderFactory> {
  try {
    const gmailModule = '../../src/providers/gmail/index.js';
    const mod = (await import(gmailModule)) as unknown as {
      gmail?: GmailProviderFactory;
      default?: GmailProviderFactory;
    };
    if (typeof mod.gmail === 'function') {
      return mod.gmail;
    }
    if (typeof mod.default === 'function') {
      return mod.default;
    }
  } catch {
    // providers/gmail not yet implemented (RED phase)
  }

  return dummyGmailFactory;
}

/**
 * Dynamically loads the buildMimeMessage function from src/providers/_shared/mime.js if implemented,
 * or falls back to a stub in the RED phase so tests execute real assertions and fail for the right reason.
 */
export async function loadBuildMimeMessage(): Promise<BuildMimeMessageFn> {
  try {
    const mimeModule = '../../src/providers/_shared/mime.js';
    const mod = (await import(mimeModule)) as unknown as {
      buildMimeMessage?: BuildMimeMessageFn;
      createMimeMessage?: BuildMimeMessageFn;
      default?: BuildMimeMessageFn;
    };
    if (typeof mod.buildMimeMessage === 'function') {
      return mod.buildMimeMessage;
    }
    if (typeof mod.createMimeMessage === 'function') {
      return mod.createMimeMessage;
    }
    if (typeof mod.default === 'function') {
      return mod.default;
    }
  } catch {
    // providers/_shared/mime not yet implemented (RED phase)
  }

  return dummyMimeBuilder;
}

/**
 * Decodes base64url string to UTF-8 text using Web standard APIs.
 */
export function decodeBase64Url(base64Url: string): string {
  let base64 = base64Url.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
  return new TextDecoder().decode(bytes);
}

function decodeRfc2047Word(_charset: string, encoding: string, text: string): string {
  const enc = encoding.toUpperCase();
  if (enc === 'B') {
    const binary = atob(text);
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
  }
  if (enc === 'Q') {
    return text
      .replaceAll('_', ' ')
      .replaceAll(/=([a-f0-9]{2})/gi, (_match: string, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16))
      );
  }
  return text;
}

/**
 * Decodes RFC 2047 encoded header fields (e.g. "=?UTF-8?B?...?=").
 */
export function decodeRfc2047(header: string): string {
  return header.replaceAll(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_, charset: string, encoding: string, text: string) =>
    decodeRfc2047Word(charset, encoding, text)
  );
}
