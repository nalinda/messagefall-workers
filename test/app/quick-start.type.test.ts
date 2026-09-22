/**
 * Type-level fixture for the README quick start (Issue #13, first acceptance criterion).
 *
 * This file is a replica of the two `src/templates.ts` and `src/index.ts` snippets in the
 * README's "Quick start" section, copied verbatim apart from the imports (resolved against
 * `src/` rather than the package name, and sorted for this repo's `simple-import-sort` rule)
 * and the two snippets living in one file. `ts-check` covers the `test` directory, so a quick
 * start that stops compiling fails the build instead of drifting away from the public types
 * in silence.
 *
 * @module
 */

/* The two blocks below are a verbatim copy of the README's quick start, so they are linted as
   the reader's own code would be, not as library source: the WhatsApp `params` renderers return
   the schema library's inferred tuple (`any[]` to the rule), and `z.string().url()` is the
   deprecated Zod spelling the snippet still uses. */
/* eslint-disable @typescript-eslint/no-unsafe-return, sonarjs/deprecation */

import type { Fetcher } from '@cloudflare/workers-types';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createMessagingApp } from '../../src/app/hono.js';
import { createMessagingClient } from '../../src/client/index.js';
import { defineTemplates, type MessagingEnv } from '../../src/index.js';
import { gmail } from '../../src/providers/gmail/index.js';
import { httpSms } from '../../src/providers/http-sms/index.js';
import { metaWhatsApp } from '../../src/providers/meta-whatsapp/index.js';

// --- README: **src/templates.ts** ---------------------------------------------------------

const templates = defineTemplates({
  loginCode: {
    input: z.object({ code: z.string().length(6) }),
    kind: 'otp',
    whatsapp: {
      template: 'login_code', // approved authentication template
      language: { en: 'en' },
      params: ({ code }) => [code],
    },
    sms: ({ code }) => `Your code is ${code}`,
  },
  matchFound: {
    input: z.object({ title: z.string(), url: z.string().url() }),
    kind: 'notification',
    whatsapp: { template: 'match_found', language: 'en', params: ({ title, url }) => [title, url] },
    sms: ({ title, url }) => `New match: ${title} ${url}`,
    email: {
      subject: ({ title }) => `New match: ${title}`,
      text: ({ title, url }) => `${title}\n${url}`,
    },
  },
});

// --- README: **src/index.ts** -------------------------------------------------------------

type Env = MessagingEnv & {
  WHATSAPP_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_VERIFY_TOKEN: string;
  SMS_GATEWAY_URL: string;
  SMS_GATEWAY_KEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
};

const app = createMessagingApp<Env>({
  templates,
  // The factory is always handed a `MessagingEnv`, whose custom bindings are `unknown`.
  // Narrow it once to your own `Env` and every secret below reads as a `string`.
  providers: (env) => {
    const e = env as Env;
    return {
      whatsapp: metaWhatsApp({
        token: e.WHATSAPP_TOKEN,
        phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
        appSecret: e.WHATSAPP_APP_SECRET,
        verifyToken: e.WHATSAPP_VERIFY_TOKEN,
      }),
      sms: httpSms({
        url: e.SMS_GATEWAY_URL,
        headers: { authorization: `Bearer ${e.SMS_GATEWAY_KEY}` },
        body: ({ to, text }) => ({ to, text }),
        messageId: (json) => (json as { id?: string }).id,
      }),
      email: gmail({
        clientId: e.GMAIL_CLIENT_ID,
        clientSecret: e.GMAIL_CLIENT_SECRET,
        refreshToken: e.GMAIL_REFRESH_TOKEN,
        from: 'no-reply@example.com',
      }),
    };
  },
  delivery: {
    fallback: ['whatsapp', 'sms'],
    always: ['email'],
    timeout: { otp: 30_000, notification: 5 * 60_000 },
  },
});

/* eslint-enable @typescript-eslint/no-unsafe-return, sonarjs/deprecation */

// --- README: "Overriding the policy" -------------------------------------------------------
//
// The snippet calls `messages.send(...)` in the CLIENT's two-argument form. Pinned here with the
// binding it assumes, so the form and the two `delivery` shorthands cannot drift the way the
// quick start once did. The README's second call names `loginCode`, which this fixture cannot
// copy verbatim: the snippet reuses one `input` across both calls, and `loginCode`'s schema is
// not `matchFound`'s. `matchFound` stands in for it, so both calls type-check against the one
// `input` the snippet has.

async function overridingThePolicy(
  binding: Fetcher,
  to: string,
  locale: string,
  input: { title: string; url: string }
): Promise<void> {
  const messages = createMessagingClient<typeof templates>({ binding });

  // default is WhatsApp -> SMS, always email
  await messages.send('matchFound', { to, locale, input, delivery: 'all' }); // all three at once
  await messages.send('matchFound', { to, locale, input, delivery: { always: [] } }); // chain only, no email
}

describe('README quick start', () => {
  it('compiles and builds a mountable Hono app', () => {
    expect(typeof app.fetch).toBe('function');
  });

  it('defines the templates the quick start names', () => {
    expect(Object.keys(templates)).toEqual(['loginCode', 'matchFound']);
  });

  it('type-checks the "Overriding the policy" snippet', () => {
    expect(typeof overridingThePolicy).toBe('function');
  });
});
