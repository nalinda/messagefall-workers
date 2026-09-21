# Providers

Each directory here is a **pluggable messaging provider**: an object satisfying the `Provider`
contract from [`types.ts`](./types.ts). Providers are plain objects, not classes, and there is no
factory or registry layer.

## Provider Contract

```typescript
interface Provider<R = unknown> {
  name: string; // unique per configuration; used in /webhooks/:name and status records
  channel: Channel; // 'whatsapp' | 'sms' | 'email'
  send(message: R & OutboundMeta): Promise<SendResult>;
  webhook?: {
    verify?(request: Request): Promise<Response | null>;
    parse(request: Request, options?: WebhookParseOptions): Promise<StatusEvent[]>;
  };
}
```

`R` is the rendered payload for the channel: `RenderedWhatsApp`, `RenderedSms` or
`RenderedEmail`. `OutboundMeta` carries `to`, `messageId`, `template`, `kind` and `locale`.

`OutboundMeta.template` is always the catalogue template name (a `string`), on every channel
and every render. A WhatsApp Meta-template render puts the approved template to send under
`RenderedWhatsApp.templateConfig` (`{ name, language, params }`) — a separate key, so a
provider handed `RenderedWhatsApp & OutboundMeta` sees both and neither overwrites the other.

A provider that does not define a `webhook` leaves attempts in the `sent` status until the
fallback chain timeout advances delivery.

### `send` (required)

```typescript
async send(message: RenderedSms & OutboundMeta): Promise<SendResult> {
  const res = await fetch(endpoint, { ... });
  if (!res.ok) {
    return {
      ok: false,
      error: formatHttpError(res.status, await res.text()),
      retryable: isRetryableStatus(res.status), // 429 and 5xx
    };
  }
  return { ok: true, providerId: '<vendor-assigned-id>' };
}
```

`SendResult` is `{ ok: true; providerId?: string }` or
`{ ok: false; error: string; retryable?: boolean }`. A `retryable` failure is retried exactly
once on the same channel before the fallback chain advances. `send` should not throw; the
pipeline converts a thrown error into a non-retryable failure.

### `webhook.parse` (optional)

Parses a delivery-status callback into `StatusEvent[]`. It **must throw** to reject an unsigned
or otherwise invalid payload — the webhook route turns that into a 401.

```typescript
webhook: {
  async parse(request, options) {
    await verifySignature(request, appSecret, options); // throws on mismatch
    return events; // StatusEvent[]
  },
}
```

### `webhook.verify` (optional)

Handles a handshake request (for example Meta's `GET` `hub.challenge` exchange). It returns
`null` when the request is not a verification request, so the route can fall through to `parse`.

## Provider Registration

There is no registry module. A provider is "registered" by being re-exported and by being put in
the `ProviderSet` a deployment builds from its env:

- A built-in provider is re-exported from [`index.ts`](./index.ts) only if it should be part of
  the default barrel — today that is `console` alone. `gmail`, `http-sms` and `meta-whatsapp` are
  deliberately left out for bundle isolation, and the tests assert each is unreachable from every
  entry point but its own, so an optional provider never lands in a consumer's bundle.
- Each provider directory is also published as its own entry point through the `./providers/*`
  subpath export in `package.json`, so `messagefall-workers/providers/meta-whatsapp` imports only
  that provider and stays tree-shakeable.
- A deployment wires them up through the `providers` option of `createMessaging`, which returns
  a `ProviderSet` keyed by channel slot. The slot key must match the provider's own `channel`,
  and each provider `name` must be unique across the set; `src/core/provider-set.ts` enforces
  both.

## Built-in Providers

- `meta-whatsapp`: Meta WhatsApp Cloud API (template and text sends, signed status webhook)
- `gmail`: Gmail API (send with an OAuth refresh token)
- `http-sms`: Generic HTTP SMS gateway skeleton
- `console`: Development mode, logs to console

## Built-in Providers (to be implemented)

- `twilio-sms`: Twilio SMS
- `vonage-sms`: Vonage SMS

## Adding a New Provider

1. Create `src/providers/<provider-name>/index.ts`.
2. Export a factory function returning an object satisfying `Provider<R>` for your channel.
3. Reuse `_shared/http.ts` (`isRetryableStatus`, `formatHttpError`), `_shared/mime.ts` and
   `_shared/meta-statuses.ts` (`parseStatuses`, for a Meta-shaped status payload) rather than
   restating them.
4. Nothing to wire up: the `./providers/*` subpath export picks the directory up automatically.
   Do NOT re-export it from `src/providers/index.ts` — that barrel is reachable from the root
   entry and carries types only, so a provider added to it would land in the bundle of every
   consumer that imports `createMessaging`.
5. Add tests (see below) and make sure `bun run lint && bun run ts-check && bun test && bun run build`
   is green.
6. Submit a pull request.

## Testing Guidelines

- **Provider tests must not make network calls** — stub `fetch` and assert on the request.
- Per-provider tests live in `test/providers/`, one file per provider
  (`test/providers/gmail.test.ts`, `test/providers/http-sms.test.ts`, …), with a directory
  (`test/providers/meta-whatsapp/`) when a provider needs several files plus fixtures.
- `test/providers/contract.test.ts` asserts every built-in provider satisfies the `Provider`
  contract; a new provider should be added there.
- Use a mock environment for local testing.
- Shared fixtures and helpers live in `test/helpers/`, and each one carries a self-test — a
  `describe` of its own with at least an "it loads" case. A helper with no `describe` never
  appears in the runner's output, which makes it look like a spec that silently failed to run.
- No message bodies in logs. Enforced two ways: `createLogger` (`src/core/logger.ts`) is the only
  writer, and its `LogFields` is a closed set of identifier and telemetry fields — there is no
  field a body, code, subject or parameter could be passed in, so content is prohibited at
  compile time rather than scrubbed at runtime; and a lint rule bans raw `console.*` anywhere
  under `src/` except the logger itself and the dev console provider, so a provider cannot route
  round that allow-list. Vendor error strings are a separate concern — they can quote the content
  back at you, and the logger does nothing about it — but that is the core's job, not yours: every
  vendor error a provider returns is run through `scrubError` (`src/core/redact.ts`) before it is
  logged or written to the status record. Return the vendor's message unaltered.

## Provider Status Mapping

`DeliveryStatus` is exactly four values. Map every vendor status onto one of them:

| Provider Status                                       | Mapped To   |
| ----------------------------------------------------- | ----------- |
| `sent`, `accepted`, `queued`                          | `sent`      |
| `delivered`                                           | `delivered` |
| `read`                                                | `read`      |
| `failed`, `error`, `undelivered`, `bounce`, `blocked` | `failed`    |

A vendor status that maps to none of these (for example a `pending` or unknown value) should be
dropped rather than reported, so the chain is not advanced on it.

## Environment Variables

Each provider may require specific environment variables:

| Variable                   | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `WHATSAPP_TOKEN`           | Meta Cloud API access token                       |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending number's id                           |
| `WHATSAPP_APP_SECRET`      | Verifies `X-Hub-Signature-256` on status webhooks |
| `WHATSAPP_VERIFY_TOKEN`    | Answers Meta's webhook verification handshake     |
| `SMS_GATEWAY_URL`          | Endpoint the `http-sms` skeleton posts to         |
| `SMS_GATEWAY_KEY`          | Bearer token for that endpoint                    |
| `GMAIL_CLIENT_ID`          | Gmail OAuth client ID                             |
| `GMAIL_CLIENT_SECRET`      | Gmail OAuth client secret                         |
| `GMAIL_REFRESH_TOKEN`      | Gmail OAuth refresh token, scope `gmail.send`     |

These are read from the Worker bindings by the provider factory in the `providers` option.

## Security Notes

- **Never log message bodies** or template parameters
- **Never log credentials** or API tokens
- **Only log**: provider name, channel, message ID, status, timestamp
- **One carve-out**: the `console` provider — and only it — also prints the recipient (`to=`),
  because a development-mode provider that sends nowhere is useless for local debugging without
  it. It is never meant to run in production, and no other provider may copy this.

## Configuration

Each provider's config should be minimal and documented:

```typescript
// src/providers/meta-whatsapp/index.ts
interface MetaWhatsAppConfig {
  token: string; // access token, sent as a bearer token
  phoneNumberId: string; // WhatsApp Business phone number id
  appSecret: string; // verifies X-Hub-Signature-256 on webhook payloads
  verifyToken: string; // expected hub.verify_token in the GET handshake
  apiVersion?: string; // Graph API version, default 'v23.0'
  name?: string; // provider instance name, default 'meta-whatsapp'
}
```

## Submission Checklist

- [ ] Implements the `Provider` contract (`name`, `channel`, `send`, optional `webhook`)
- [ ] `send` returns a `SendResult` and never throws
- [ ] `webhook.parse` throws on an unsigned or invalid payload
- [ ] Vendor statuses map onto the four `DeliveryStatus` values
- [ ] No hardcoded credentials, no message content in logs
- [ ] Covered by `test/providers/contract.test.ts` and its own test file
- [ ] `bun run lint && bun run ts-check && bun test && bun run build` passes
