# messagefall-workers

Outbound messaging for Cloudflare Workers. Send over WhatsApp first and fall back to SMS when delivery fails or times out, send email alongside or instead, define templates once with typed inputs, receive delivery-status webhooks, and let other Workers send through a service binding.

The name is the feature: a message _falls_ from the preferred channel to the next one, driven by real delivery status rather than hope.

It is deliberately small. Every provider, including WhatsApp, is a plugin behind one contract: a `send` function and, if the provider reports delivery, a webhook handler. Built-in providers cover the common vendors; a local SMS gateway is ten lines. State lives in KV, with an optional Durable Object for timed fallback. Nothing runs outside your Worker.

> **Status:** pre-release. The API described here is the target for 0.1.0 and may change before then.

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Installation](#installation)
- [Quick start](#quick-start)
- [How delivery works](#how-delivery-works)
- [Templates](#templates)
- [Providers](#providers)
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
- **Vendors change.** A gateway that is cheapest this year is not next year. Swapping one should touch a config line, not the pipeline.
- **Codes must never be logged.** A one-time code passing through a messaging layer is a secret in transit.

This package handles those four things and leaves the rest to you.

## Features

- **WhatsApp first, SMS fallback**, triggered by a failed delivery status or by a timeout you configure per message kind.
- **Always-on channels** that send in parallel with the fallback chain, for example email with every message.
- **Delivery policy at three levels**: a default, a per-template override, and a per-send override, including "every channel this template defines".
- **Email** as a channel with the same template and provider contract.
- **Typed templates**: define a message once with an input schema and per-channel renderings, including Meta template names and parameters. Sending a template with the wrong input is a type error.
- **Pluggable providers.** One contract for WhatsApp, SMS and email. The first release ships Meta Cloud API for WhatsApp, a generic HTTP gateway for SMS, Gmail for email, and a console provider for development. More vendors follow as separate entry points.
- **Provider-owned webhooks.** Each provider that reports delivery verifies and parses its own status callbacks at `/webhooks/<provider>`, and the package correlates them back to the send.
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
    "bindings": [{ "name": "FALLBACK_TIMER", "class_name": "FallbackTimer" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FallbackTimer"] }],
}
```

Secrets, set with `wrangler secret put`:

| Secret                                                          | Purpose                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `WHATSAPP_TOKEN`                                                | Meta Cloud API access token.                                         |
| `WHATSAPP_PHONE_NUMBER_ID`                                      | The sending number's id.                                             |
| `WHATSAPP_APP_SECRET`                                           | Verifies webhook signatures.                                         |
| `WHATSAPP_VERIFY_TOKEN`                                         | Answers Meta's webhook verification handshake.                       |
| `SMS_GATEWAY_URL`, `SMS_GATEWAY_KEY`                            | Whatever your SMS gateway needs.                                     |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | OAuth credentials for the sending Gmail account, scope `gmail.send`. |

**src/templates.ts**

```ts
import { defineTemplates } from 'messagefall-workers';
import { z } from 'zod';

export const templates = defineTemplates({
  loginCode: {
    input: z.object({ code: z.string().length(6) }),
    kind: 'otp',
    whatsapp: {
      template: 'login_code', // approved authentication template
      language: { en: 'en', si: 'si_LK', ta: 'ta_LK' },
      params: ({ code }) => [code],
    },
    sms: ({ code }, locale) => (locale === 'si' ? `ඔබගේ කේතය ${code}` : `Your code is ${code}`),
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
import { createMessagingApp, type MessagingEnv } from 'messagefall-workers';
import { metaWhatsApp } from 'messagefall-workers/providers/meta-whatsapp';
import { httpSms } from 'messagefall-workers/providers/http-sms';
import { gmail } from 'messagefall-workers/providers/gmail';
import { templates } from './templates';

export { FallbackTimer } from 'messagefall-workers/durable';

type Env = MessagingEnv & {
  SMS_GATEWAY_URL: string;
  SMS_GATEWAY_KEY: string;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
};

export default createMessagingApp<Env>({
  templates,
  providers: (env) => ({
    whatsapp: metaWhatsApp({
      token: env.WHATSAPP_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      appSecret: env.WHATSAPP_APP_SECRET,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    }),
    sms: httpSms({
      url: env.SMS_GATEWAY_URL,
      headers: { authorization: `Bearer ${env.SMS_GATEWAY_KEY}` },
      body: ({ to, text }) => ({ to, text }),
      messageId: (json) => json.id,
    }),
    email: gmail({
      clientId: env.GMAIL_CLIENT_ID,
      clientSecret: env.GMAIL_CLIENT_SECRET,
      refreshToken: env.GMAIL_REFRESH_TOKEN,
      from: 'no-reply@example.com',
    }),
  }),
  delivery: {
    fallback: ['whatsapp', 'sms'],
    always: ['email'],
    timeout: { otp: 30_000, notification: 5 * 60_000 },
  },
});
```

That Worker now serves:

| Route             | Purpose                         |
| ----------------- | ------------------------------- |
| `POST /send`      | Send a template to a recipient. |
| `GET /status/:id` | Delivery status of a message.   |
| `GET              | POST /webhooks/:provider`       | Delivery-status callbacks, dispatched to the named provider. |

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

Without the Durable Object binding, steps 3 and 5 do not happen: chain fallback is driven only by explicit failure statuses, and the app logs one `timer.off` line on its first request so the missing binding is visible. That is enough for notifications. For one-time codes you want the timer, because "no status yet" after thirty seconds is the common failure mode, not an explicit rejection.

The timer is one Durable Object per message, named by the message id. Its alarm re-creates the messaging core from the options passed to `createMessagingApp` (or `createMessaging`) in the same isolate, and an isolate woken only by an alarm runs nothing but module evaluation before the handler. So `FallbackTimer` must be exported from the same Worker module that calls `createMessagingApp`, and that call must run at module top level (`const app = createMessagingApp({...})` at module scope, as the quick start does), not lazily inside a request handler; the last registration in an isolate wins, so configure one set of options per Worker. If an alarm fires with no options registered it throws and keeps its state for the platform's retry. A chain with only one channel, or a `'all'` policy, never arms it: there is nothing a timeout could move on to.

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
await messages.send('accountLocked', { to, locale, input, delivery: 'all' }); // all three at once
await messages.send('loginCode', { to, locale, input, delivery: { always: [] } }); // chain only, no email
```

A channel that appears in both `fallback` and `always` is sent once, as part of `always`. A template that defines none of the resolved channels is a send-time error with a clear message.

Send calls carry `to` (the E.164 phone number) and an optional `email` field (`{ to, email?, ... }`) so a template can reach an inbox. When the resolved policy includes `email` and no `email` address is provided, the email channel is dropped from the policy with a logged `send.channel-skipped` event rather than failing the send, and phone channels proceed normally.

Fallback never re-renders with a different input. The same input renders each channel's version of the same template.

## Templates

`defineTemplates` takes a record of templates. Each has:

| Field      | Required | Description                                                                                                                                                        |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input`    | yes      | Any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType). Drives the type of `send`.                                                    |
| `kind`     | yes      | `'otp'` or `'notification'`. Selects the fallback timeout and the logging rule.                                                                                    |
| `whatsapp` | no       | Meta template name, language per locale, and a function from input to the template's parameters. Or `text` for free-form messages inside a 24-hour service window. |
| `sms`      | no       | Function from input and locale to text.                                                                                                                            |
| `email`    | no       | Subject, text and optional HTML, each a function of input and locale.                                                                                              |
| `delivery` | no       | Policy override for this template: `{ fallback?, always? }` or `'all'`. See [Overriding the policy](#overriding-the-policy).                                       |

A template with only `sms` defined skips WhatsApp regardless of the policy's `fallback`. Sending to a template that defines no channel in the order is a configuration error at startup, not at send time.

Meta requires one-time codes to use an approved **authentication-category** template. The package does not submit templates for you; it does refuse to send a `kind: 'otp'` template over WhatsApp as free text.

## Providers

A provider is one object that knows how to send on one channel and, optionally, how to read its own delivery callbacks:

```ts
interface Provider<Rendered> {
  name: string; // used in /webhooks/:name and in status records
  channel: 'whatsapp' | 'sms' | 'email';
  send(
    message: Rendered & { to: string; messageId: string }
  ): Promise<{ ok: true; providerId?: string } | { ok: false; error: string; retryable?: boolean }>;
  webhook?: {
    verify?(request: Request): Promise<Response | null>; // e.g. Meta's GET handshake
    parse(request: Request): Promise<StatusEvent[]>; // must check the signature; throw to reject
  };
}
```

`StatusEvent` is `{ providerId, status: 'sent' | 'delivered' | 'read' | 'failed', error?, at }`. The package correlates `providerId` back to the attempt and drives fallback from there. A provider with no `webhook` still works; its attempts simply stay `sent` until the chain timeout.

### Built in

Each provider is its own entry point so unused vendors never reach your bundle.

Shipped in 0.1.0:

| Import                                        | Channel  | Delivery status                       |
| --------------------------------------------- | -------- | ------------------------------------- |
| `messagefall-workers/providers/meta-whatsapp` | whatsapp | webhook, signed with the app secret   |
| `messagefall-workers/providers/http-sms`      | sms      | none, or a `webhook.parse` you supply |
| `messagefall-workers/providers/gmail`         | email    | none                                  |
| `messagefall-workers/providers/console`       | any      | simulated, for development            |

Planned as separate entry points after 0.1.0: `twilio-whatsapp`, `twilio-sms`, `vonage-sms`, `resend`, `postmark`, `cloudflare-email`, and `route()` for several providers on one channel.

`httpSms` is the escape hatch for a regional gateway with a plain HTTP API. You give it the URL, headers, a body mapper and how to read the message id from the response, and optionally a `webhook.parse` if the gateway posts delivery reports.

`gmail` sends through the Gmail API with an OAuth refresh token for the sending account. Gmail reports no delivery status, so email attempts stay `sent`; that is fine for an always-on channel and is why email is not the default first link in a fallback chain.

### Writing your own

Implement the interface above and pass it in `providers`. There is no registration step. A provider is a plain object, so it can be tested without the package. The `console` provider's source is the smallest complete example; `meta-whatsapp` is the reference for a signed webhook.

### Several providers on one channel

Planned after 0.1.0: `route()` picks a provider per destination, for example a domestic gateway for local numbers and a global carrier for the rest, and is itself a provider so it composes. Until then, one provider per channel.

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
  "always": [{ "channel": "email", "providerId": "re_...", "status": "delivered", "at": "..." }],
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
  email: 'user@example.com', // optional: required if resolved policy includes email, otherwise email is skipped
  locale: 'en',
  input: { title: 'Bicycle, Kandy', url: 'https://example.com/m/123' },
  delivery: 'all', // optional per-send override
});
```

Service-binding calls stay inside Cloudflare's network. The API Worker never holds a provider credential.

## Configuration

`createMessagingApp(options)` returns a Hono app. `createMessaging(env, options)` returns the underlying sender for use in any framework.

| Option              | Type                                      | Default                                | Description                                                                                                           |
| ------------------- | ----------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `templates`         | `Templates`                               | required                               | From `defineTemplates`.                                                                                               |
| `providers`         | `(env) => { whatsapp?, sms?, email? }`    | required                               | One provider per channel, built from bindings per request.                                                            |
| `delivery.fallback` | `Channel[]`                               | `['whatsapp', 'sms']`                  | Ordered chain. Each channel is tried only if the previous failed or timed out.                                        |
| `delivery.always`   | `Channel[]`                               | `[]`                                   | Channels sent in parallel with the chain on every message.                                                            |
| `delivery.timeout`  | `{ otp?: number; notification?: number }` | `{ otp: 30000, notification: 300000 }` | Milliseconds before the chain moves to the next channel when no status has arrived. Needs the Durable Object binding. |
| `kv`                | `KVNamespace`                             | `env.MESSAGES_KV`                      | Status store.                                                                                                         |
| `timer`             | `DurableObjectNamespace`                  | `env.FALLBACK_TIMER`                   | Optional. Enables timed fallback.                                                                                     |
| `statusTtl`         | `number`                                  | `604800`                               | Seconds to keep status records.                                                                                       |
| `onStatus`          | `(event) => void \| Promise<void>`        | none                                   | Called on every status change. Receives ids and statuses, never bodies.                                               |
| `basePath`          | `string`                                  | `'/'`                                  | Path prefix for the routes.                                                                                           |

## Routing and webhooks

Every provider that reports delivery gets its own route at `/webhooks/<provider name>`. Point each vendor's callback there:

| Provider        | Vendor setting                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta-whatsapp` | Meta app dashboard, webhook URL `<public-url>/webhooks/meta-whatsapp`, subscribe to `messages`. The `GET` handshake uses `WHATSAPP_VERIFY_TOKEN`; `POST` is verified with `WHATSAPP_APP_SECRET`. |
| `http-sms`      | Only if you supplied `webhook.parse`: point the gateway's delivery-report URL at `<public-url>/webhooks/http-sms`.                                                                               |
| `gmail`         | None. Gmail reports no delivery status.                                                                                                                                                          |

A request to `/webhooks/<name>` for a provider that is not configured returns 404. A provider whose `parse` throws returns 401. Unsigned payloads are never accepted outside development.

The webhook routes are the only routes that need to be public. `/send` and `/status` are meant to be reached over a service binding. If the Worker is exposed on a public hostname, put those behind your own authentication or a Cloudflare Access policy; the package does not add auth of its own.

## Local development

`wrangler dev` provides local KV and Durable Objects automatically.

- Use the `console` provider for each channel during development. It prints the recipient and channel, deliberately not the body for `otp` templates, and can simulate a delivered or failed status after a delay so fallback is exercised without any vendor.
- Vendor webhooks cannot reach localhost. `POST /webhooks/<provider>` accepts an unsigned payload when `MESSAGING_DEV_UNSIGNED=true` is set, so you can replay a status event from a file. Never set that in production.
- The `examples/basic` directory has a runnable Worker with console providers and a script that replays failed and delivered statuses to exercise fallback.

## Compatibility

| Dependency                                | Version                            |
| ----------------------------------------- | ---------------------------------- |
| wrangler                                  | ^4                                 |
| hono (optional, for `createMessagingApp`) | ^4                                 |
| Standard Schema validators                | Zod ^3.23 / ^4, Valibot, ArkType   |
| Meta Cloud API                            | Graph v23 by default, configurable |

No Node compatibility flag is required.

## FAQ

**Why not a verification service that does WhatsApp-then-SMS already?**
They do, at their SMS rates and only for codes. If you have a cheaper local gateway, or want notifications on the same path, you need the router yourself. This package is that router.

**Can I send on every channel for some messages and use fallback for others?**
Yes. Set the default policy once, override it on the templates that differ, and override again on a single send when needed. `delivery: 'all'` is the shorthand for every channel the template defines. See [Overriding the policy](#overriding-the-policy).

**Does it retry within a channel?**
Once, for provider results marked `retryable`. Beyond that it moves to the next channel. Vendor-side retries are the vendor's job.

**My SMS gateway is not on the list.**
Use `httpSms` if it has a plain HTTP API, which covers most regional gateways. If it needs signing or a session, implement the provider interface; it is one object with a `send` function.

**Can I use a WhatsApp BSP instead of Meta directly?**
Yes, as a provider like any other; a Twilio WhatsApp provider is planned after 0.1.0. The template catalog does not care which provider carries a WhatsApp message.

**Why a Durable Object rather than Queues for the timer?**
An alarm per pending message is exact, cheap, and available on the free plan. Queues with a delay also work and may come later as an alternative timer, but they add a consumer to deploy.

**Can I use it without Hono?**
Yes. `createMessaging(env, options)` gives you `send`, `status` and `handleWebhook` as functions. `createMessagingApp` is a thin Hono wrapper around them.

**Does it handle inbound WhatsApp messages?**
No. This is outbound only. Inbound events other than delivery statuses are acknowledged and dropped. If you need two-way chat, you want a different kind of library.

**What about push notifications or Telegram?**
Not planned as channels. The provider contract is small enough that a custom one takes an afternoon, but the package stays focused on the WhatsApp, SMS and email triangle.

## Contributing

Issues and pull requests are welcome. Please open an issue before a large change so the design can be discussed first. Development uses Bun for tests and wrangler for the example Worker:

```sh
bun install
bun test
bun run --cwd examples/basic dev
```

## License

MIT. See [LICENSE](LICENSE).
