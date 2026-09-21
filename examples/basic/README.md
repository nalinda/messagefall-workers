# Basic Worker Example

This is a complete, runnable Cloudflare Worker demonstrating `messagefall-workers` using only the built-in `consoleProvider`. No vendor credentials or external network calls are required.

## Features Demonstrated

- **Template Catalogue**: Notification (`orderUpdate` with WhatsApp -> SMS fallback and always-on email) and OTP (`loginCode` with WhatsApp -> SMS fallback).
- **Console Providers**: Logs message dispatches locally while redacting sensitive OTP payload bodies.
- **Timed Fallback**: `FallbackTimer` Durable Object configured with SQLite migrations for local timer-based fallback.
- **Status & Webhook Routes**: Mounts `/send`, `/status/:id`, and `/webhooks/:provider`.

## Running Locally

This example imports `messagefall-workers` but declares no dependency on it: inside this
repository it resolves through the root `tsconfig.json`'s `paths` mapping, straight to the
library's TypeScript source rather than to the built package. Copying these files out of the repo
therefore needs the package installed first — see the root README's install instructions.

Run the example with `wrangler dev`:

```sh
bun run --cwd examples/basic dev
```

or with wrangler directly:

```sh
npx wrangler dev -c examples/basic/wrangler.jsonc
```

## Example Requests

### 1. Send a Notification (WhatsApp + Email, fallback to SMS)

```sh
curl -X POST http://localhost:8787/send \
  -H "Content-Type: application/json" \
  -d '{
    "template": "orderUpdate",
    "to": "+94771234567",
    "email": "customer@example.com",
    "locale": "en",
    "input": {
      "orderId": "ORD-1234",
      "status": "Shipped"
    }
  }'
```

Response:

```json
{ "id": "msg_01J..." }
```

### 2. Check Delivery Status

```sh
curl http://localhost:8787/status/msg_01J...
```

### 3. Send an OTP Code

```sh
curl -X POST http://localhost:8787/send \
  -H "Content-Type: application/json" \
  -d '{
    "template": "loginCode",
    "to": "+94771234567",
    "locale": "en",
    "input": {
      "code": "482913"
    }
  }'
```

### 4. Post a Webhook Delivery Status

These posts carry no vendor signature, so `wrangler.jsonc` sets
`MESSAGING_DEV_UNSIGNED: "true"` for this example — without it the route answers `401`. The
library only honours that bypass on a loopback host (`localhost`, `127.0.0.1`, `[::1]`), so it
stays local to `wrangler dev`; never set it in a real config.

Simulate a failed delivery for WhatsApp to trigger SMS fallback:

```sh
curl -X POST http://localhost:8787/webhooks/console-whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "console_msg_01J...",
    "status": "failed"
  }'
```

Simulate a successful delivery for SMS:

```sh
curl -X POST http://localhost:8787/webhooks/console-sms \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "console_msg_01J...",
    "status": "delivered"
  }'
```
