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

- Built-in providers are re-exported from [`index.ts`](./index.ts).
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
- `stub`: In-memory provider for tests and local runs

## Built-in Providers (to be implemented)

- `twilio-sms`: Twilio SMS
- `vonage-sms`: Vonage SMS

## Adding a New Provider

1. Create `src/providers/<provider-name>/index.ts`.
2. Export a factory function returning an object satisfying `Provider<R>` for your channel.
3. Reuse `_shared/http.ts` (`isRetryableStatus`, `formatHttpError`) and `_shared/mime.ts` rather
   than restating them.
4. Re-export it from `src/providers/index.ts` if it should be part of the default barrel. The
   `./providers/*` subpath export picks the directory up automatically.
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
- No message bodies in logs (enforced by the logger and the linter).

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

| Variable              | Description                   |
| --------------------- | ----------------------------- |
| `META_WHATSAPP_*`     | Meta WhatsApp API credentials |
| `TWILIO_ACCOUNT_SID`  | Twilio account SID            |
| `TWILIO_AUTH_TOKEN`   | Twilio auth token             |
| `VONAGE_FROM`         | Vonage phone number           |
| `GMAIL_CLIENT_ID`     | Gmail OAuth client ID         |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth client secret     |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth refresh token     |

These are read from the Worker bindings by the provider factory in the `providers` option.

## Security Notes

- **Never log message bodies** or template parameters
- **Never log credentials** or API tokens
- **Only log**: provider name, channel, message ID, status, timestamp

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
