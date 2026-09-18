# messagefall-workers

Outbound messaging for Cloudflare Workers. Send over WhatsApp first and fall back to SMS when delivery fails or times out, send email alongside or instead, define templates once with typed inputs, receive delivery-status webhooks, and let other Workers send through a service binding.

The name is the feature: a message *falls* from the preferred channel to the next one, driven by real delivery status rather than hope.

It is deliberately small. Providers are plain `fetch` calls behind a transport interface, so a local SMS gateway is ten lines and no vendor is assumed. State lives in KV, with an optional Durable Object for timed fallback. Nothing runs outside your Worker.

> **Status:** pre-release. The API described here is the target for 0.1.0 and may change before then.

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How delivery works](#how-delivery-works)
- [Templates](#templates)
- [Channels and transports](#channels-and-transports)
- [One-time codes](#one-time-codes)
- [Delivery status](#delivery-status)
- [Sending from another Worker](#sending-from-another-worker)
- [Configuration](#configuration)
- [Routing and webhooks](#routing-and-webhooks)
- [Local development](#local-development)
- [Compatibility](#compatibility)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

WhatsApp is cheaper and more reliable than SMS in many markets, but not everyone has it and Meta's delivery is not instant. The usual answer is a verification service that does WhatsApp-then-SMS for you, at the vendor's SMS rates. If you have a local SMS gateway that is materially cheaper, or you want notifications and codes to share one pipeline, you end up writing the fallback yourself.

On Workers that has some specific shape:

- **Delivery status arrives as a webhook**, not a return value. Deciding to fall back means correlating a status event with a message you sent a moment ago, across isolates.
- **"Fall back after N seconds" needs a timer.** Workers have no `setTimeout` that outlives the request. A Durable Object alarm is the clean answer.
- **Credentials belong in one place.** Every Worker that sends should hold a service binding, not the WhatsApp token.
- **Codes must never be logged.** A one-time code passing through a messaging layer is a secret in transit.

This package handles those four things and leaves the rest to you.

## Features

- **WhatsApp first, SMS fallback**, triggered by a failed delivery status or by a timeout you configure per message kind.
- **Always-on channels** that send in parallel with the fallback chain, for example email with every message.
- **Delivery policy at three levels**: a default, a per-template override, and a per-send override, including "every channel this template defines".
- **Email** as a channel with the same template and transport contract.
- **Typed templates**: define a message once with an input schema and per-channel renderings, including Meta template names and parameters. Sending a template with the wrong input is a type error.
- **Transports are plain functions.** The Meta Cloud API transport is included. SMS and email transports are whatever `fetch` call your provider needs.
- **Meta webhook handling**: verification handshake, signature check, status parsing, and correlation back to the original send.
- **Delivery-status store in KV** with a TTL, queryable by message id.
- **Timed fallback through a Durable Object alarm**, optional. Without it, fallback still happens on a failed status.
- **`createMessagingClient`** for other Workers: send over a service binding with the same typed template catalog.
- **No message bodies in logs**, enforced in code.
- Typed `Env` so a missing binding is a type error.

## Installation

```sh
npm install messagefall-workers
```

No other runtime dependencies. Hono is an optional peer dependency for the ready-made app.

## Quick start

A Worker that sends WhatsApp with SMS fallback through a local gateway, and receives Meta's status webhooks.

**wrangler.jsonc**

```jsonc
{
  "name": "messaging",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-16",
  "kv_namespaces": [{ "binding": "MESSAGES_KV", "id": "<kv-id>" }],
  "durable_objects": {
    "bindings": [{ "name": "FALLBACK_TIMER", "class_name": "FallbackTimer" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FallbackTimer"] }]
}
```

Secrets, set with `wrangler secret put`:

| Secret | Purpose |
| --- | --- |
| `WHATSAPP_TOKEN` | Meta Cloud API access token. |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending number's id. |
| `WHATSAPP_APP_SECRET` | Verifies webhook signatures. |
| `WHATSAPP_VERIFY_TOKEN` | Answers Meta's webhook verification handshake. |
| `SMS_GATEWAY_URL`, `SMS_GATEWAY_KEY` | Whatever your SMS provider needs. |

**src/templates.ts**

```ts
import { defineTemplates } from 'messagefall-workers';
import { z } from 'zod';

export const templates = defineTemplates({
  loginCode: {
    input: z.object({ code: z.string().length(6) }),
    kind: 'otp',
    whatsapp: {
      template: 'login_code',            // approved authentication template
      language: { en: 'en', si: 'si_LK', ta: 'ta_LK' },
      params: ({ code }) => [code],
    },
    sms: ({ code }, locale) =>
      locale === 'si' ? `ඔබගේ කේතය ${code}` : `Your code is ${code}`,
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
```

**src/index.ts**

```ts
import { createMessagingApp, metaWhatsApp, type MessagingEnv } from 'messagefall-workers';
import { templates } from './templates';

export { FallbackTimer } from 'messagefall-workers/durable';

type Env = MessagingEnv & { SMS_GATEWAY_URL: string; SMS_GATEWAY_KEY: string };

export default createMessagingApp<Env>({
  templates,
  channels: (env) => ({
    whatsapp: metaWhatsApp({
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      appSecret: env.WHATSAPP_APP_SECRET,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    }),
    sms: {
      send: async ({ to, text }) => {
        const res = await fetch(env.SMS_GATEWAY_URL, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.SMS_GATEWAY_KEY}` },
          body: JSON.stringify({ to, text }),
        });
        return res.ok ? { ok: true, providerId: (await res.json()).id } : { ok: false, error: await res.text() };
      },
    },
  }),
  delivery: {
    fallback: ['whatsapp', 'sms'],
    always: ['email'],
    timeout: { otp: 30_000, notification: 5 * 60_000 },
  },
});
```

That Worker now serves:

| Route | Purpose |
| --- | --- |
| `POST /send` | Send a template to a recipient. |
| `GET /status/:id` | Delivery status of a message. |
| `GET /webhooks/whatsapp` | Meta verification handshake. |
| `POST /webhooks/whatsapp` | Meta status events. |

Sending:

```sh
curl -X POST https://messaging.example.com/send \
  -d '{"template":"loginCode","to":"+94771234567","locale":"si","input":{"code":"482913"}}'
```

## How delivery works

A delivery policy has two parts:

- **`fallback`**: an ordered chain. The first channel the template defines is tried; the next is tried only if the previous one fails or times out.
- **`always`**: a set of channels sent in parallel with the chain, every time, regardless of how the chain goes.

With `fallback: ['whatsapp', 'sms']` and `always: ['email']`, a message goes out over WhatsApp and email at once; SMS follows only if WhatsApp fails.

The chain runs like this:

1. The message is rendered for the first channel in `fallback` that the template defines and the recipient can receive, and sent. Every channel in `always` that the template defines is rendered and sent at the same time.
2. Each attempt's provider message id is stored in KV under the message id, with status `sent`.
3. If a Durable Object timer is bound, an alarm is set for the template kind's timeout. The alarm watches the chain only.
4. When a status webhook arrives it is verified, matched to the attempt, and stored. For the chain, `delivered` or `read` cancels the alarm and `failed` triggers the next channel immediately. For an `always` channel, the status is recorded and nothing else happens.
5. If the alarm fires and the chain's current attempt is still `sent`, the next channel is tried.
6. When no chain channels remain, the chain is marked `failed` with the last error. `always` channels do not affect the chain's outcome.

Without the Durable Object binding, steps 3 and 5 do not happen: chain fallback is driven only by explicit failure statuses. That is enough for notifications. For one-time codes you want the timer, because "no status yet" after thirty seconds is the common failure mode, not an explicit rejection.

### Overriding the policy

The policy resolves in this order, most specific wins:

1. **Per send.** `delivery` on the send call.
2. **Per template.** `delivery` on the template definition.
3. **Default.** `delivery` in the configuration.

Each level may set `fallback`, `always`, or both; unset parts inherit from the next level. Two shorthands exist:

- `delivery: 'all'` sends every channel the template defines in parallel, with no chain.
- `delivery: { fallback: ['sms'] , always: [] }` sends SMS only, ignoring the default's email.

```ts
// default is WhatsApp -> SMS, always email
await messages.send('accountLocked', { to, locale, input, delivery: 'all' });          // all three at once
await messages.send('loginCode',     { to, locale, input, delivery: { always: [] } }); // chain only, no email
```

A channel that appears in both `fallback` and `always` is sent once, as part of `always`. A template that defines none of the resolved channels is a send-time error with a clear message.

Fallback never re-renders with a different input. The same input renders each channel's version of the same template.

## Templates

`defineTemplates` takes a record of templates. Each has:

| Field | Required | Description |
| --- | --- | --- |
| `input` | yes | Any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType). Drives the type of `send`. |
| `kind` | yes | `'otp'` or `'notification'`. Selects the fallback timeout and the logging rule. |
| `whatsapp` | no | Meta template name, language per locale, and a function from input to the template's parameters. Or `text` for free-form messages inside a 24-hour service window. |
| `sms` | no | Function from input and locale to text. |
| `email` | no | Subject, text and optional HTML, each a function of input and locale. |
| `delivery` | no | Policy override for this template: `{ fallback?, always? }` or `'all'`. See [Overriding the policy](#overriding-the-policy). |

A template with only `sms` defined skips WhatsApp regardless of the policy's `fallback`. Sending to a template that defines no channel in the order is a configuration error at startup, not at send time.

Meta requires one-time codes to use an approved **authentication-category** template. The package does not submit templates for you; it does refuse to send a `kind: 'otp'` template over WhatsApp as free text.

## Channels and transports

A transport is one function:

```ts
type Transport<Rendered> = (message: Rendered & { to: string; messageId: string }) =>
  Promise<{ ok: true; providerId?: string } | { ok: false; error: string; retryable?: boolean }>;
```

- **WhatsApp**: `metaWhatsApp(config)` is included. It sends template and text messages through the Cloud API and owns the webhook routes. Bring your own transport for a BSP if you use one.
- **SMS**: no vendor is assumed. Write the `fetch` call. Examples in `examples/transports` cover a generic HTTP gateway and Twilio.
- **Email**: same contract, with `subject`, `text` and `html` on the rendered message. Examples cover Resend and Cloudflare Email Workers.

Phone numbers must be E.164 on the way in. A normaliser for one country is a few lines and belongs in your app, not here.

## One-time codes

Templates with `kind: 'otp'` get four behaviours:

- The send is dispatched under `ctx.waitUntil` and `POST /send` returns as soon as the message is accepted and recorded, so response time does not reveal whether a number exists.
- The chain timeout is the `otp` value, defaulting to thirty seconds. `always` channels for an OTP template are allowed but unusual; most codes want the chain only.
- Rendered bodies and inputs are never written to logs, status records, or error messages. Only the message id, channel, provider id and status are stored.
- Codes are never queued. If every channel fails, the status is `failed` and the caller decides what to do.

The package does not generate or verify codes. Pair it with your auth layer, which owns the code, and hand this package only the delivery.

## Delivery status

Every send gets a message id. `GET /status/:id` returns:

```json
{
  "id": "msg_01J...",
  "template": "loginCode",
  "kind": "otp",
  "chain": {
    "status": "sent",
    "attempts": [
      { "channel": "whatsapp", "providerId": "wamid.HBg...", "status": "failed", "at": "..." },
      { "channel": "sms", "providerId": "8f2c...", "status": "sent", "at": "..." }
    ]
  },
  "always": [
    { "channel": "email", "providerId": "re_...", "status": "delivered", "at": "..." }
  ],
  "status": "sent"
}
```

The top-level `status` is the chain's status, or the worst of the `always` attempts when there is no chain. Records live in KV with a TTL, seven days by default. There is no history beyond that; if you want reporting, subscribe with `onStatus` in the configuration and write wherever you like.

## Sending from another Worker

Bind the messaging Worker as a service and use the client with the same template catalog, so sends are typed end to end:

```jsonc
// api/wrangler.jsonc
"services": [{ "binding": "MESSAGES", "service": "messaging" }]
```

```ts
import { createMessagingClient } from 'messagefall-workers/client';
import type { templates } from '../../messaging/src/templates';

const messages = createMessagingClient<typeof templates>({ binding: env.MESSAGES });

await messages.send('matchFound', {
  to: '+94771234567',
  locale: 'en',
  input: { title: 'Bicycle, Kandy', url: 'https://example.com/m/123' },
  delivery: 'all', // optional per-send override
});
```

Service-binding calls stay inside Cloudflare's network. The API Worker never holds a provider credential.

## Configuration

`createMessagingApp(options)` returns a Hono app. `createMessaging(env, options)` returns the underlying sender for use in any framework.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `templates` | `Templates` | required | From `defineTemplates`. |
| `channels` | `(env) => { whatsapp?, sms?, email? }` | required | Transports, built from bindings per request. |
| `delivery.fallback` | `Channel[]` | `['whatsapp', 'sms']` | Ordered chain. Each channel is tried only if the previous failed or timed out. |
| `delivery.always` | `Channel[]` | `[]` | Channels sent in parallel with the chain on every message. |
| `delivery.timeout` | `{ otp?: number; notification?: number }` | `{ otp: 30000, notification: 300000 }` | Milliseconds before the chain moves to the next channel when no status has arrived. Needs the Durable Object binding. |
| `kv` | `KVNamespace` | `env.MESSAGES_KV` | Status store. |
| `timer` | `DurableObjectNamespace` | `env.FALLBACK_TIMER` | Optional. Enables timed fallback. |
| `statusTtl` | `number` | `604800` | Seconds to keep status records. |
| `onStatus` | `(event) => void \| Promise<void>` | none | Called on every status change. Receives ids and statuses, never bodies. |
| `basePath` | `string` | `'/'` | Path prefix for the routes. |

## Routing and webhooks

Point Meta's webhook at `<public-url>/webhooks/whatsapp` and subscribe to the `messages` field. The `GET` handler answers the verification challenge with `WHATSAPP_VERIFY_TOKEN`; the `POST` handler verifies `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET` and rejects anything unsigned.

The webhook route is the only route that needs to be public. `/send` and `/status` are meant to be reached over a service binding. If the Worker is exposed on a public hostname, put those behind your own authentication or a Cloudflare Access policy; the package does not add auth of its own.

## Local development

`wrangler dev` provides local KV and Durable Objects automatically.

- Use a console transport for each channel during development. `consoleTransport()` prints the recipient and channel, and deliberately not the body for `otp` templates.
- Meta webhooks cannot reach localhost. `POST /webhooks/whatsapp` accepts an unsigned payload when `MESSAGING_DEV_UNSIGNED=true` is set, so you can replay a status event from a file. Never set that in production.
- The `examples/basic` directory has a runnable Worker with console transports and a script that replays failed and delivered statuses to exercise fallback.

## Compatibility

| Dependency | Version |
| --- | --- |
| wrangler | ^4 |
| hono (optional, for `createMessagingApp`) | ^4 |
| Standard Schema validators | Zod ^3.23 / ^4, Valibot, ArkType |
| Meta Cloud API | Graph v23 by default, configurable |

No Node compatibility flag is required.

## FAQ

**Why not a verification service that does WhatsApp-then-SMS already?**
They do, at their SMS rates and only for codes. If you have a cheaper local gateway, or want notifications on the same path, you need the router yourself. This package is that router.

**Can I send on every channel for some messages and use fallback for others?**
Yes. Set the default policy once, override it on the templates that differ, and override again on a single send when needed. `delivery: 'all'` is the shorthand for every channel the template defines. See [Overriding the policy](#overriding-the-policy).

**Does it retry within a channel?**
Once, for transport results marked `retryable`. Beyond that it moves to the next channel. Provider-side retries are the provider's job.

**Why a Durable Object rather than Queues for the timer?**
An alarm per pending message is exact, cheap, and available on the free plan. Queues with a delay also work and may come later as an alternative timer, but they add a consumer to deploy.

**Can I use it without Hono?**
Yes. `createMessaging(env, options)` gives you `send`, `status` and `handleWebhook` as functions. `createMessagingApp` is a thin Hono wrapper around them.

**Does it handle inbound WhatsApp messages?**
No. This is outbound only. Inbound events other than delivery statuses are acknowledged and dropped. If you need two-way chat, you want a different kind of library.

**What about push notifications or Telegram?**
Not planned. The channel contract is small enough that a custom transport takes an afternoon, but the package stays focused on the WhatsApp, SMS and email triangle.

## Contributing

Issues and pull requests are welcome. Please open an issue before a large change so the design can be discussed first. Development uses Bun for tests and wrangler for the example Worker:

```sh
bun install
bun test
bun run --cwd examples/basic dev
```

## License

MIT. See [LICENSE](LICENSE).
