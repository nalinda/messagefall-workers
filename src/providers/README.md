# Providers

Each provider in this directory is a **pluggable messaging provider** that implements a common contract.

## Provider Contract

A provider must implement the `Provider` interface:

```typescript
interface Provider {
  readonly id: string;
  readonly channel: Channel;
  send(options: ProviderSendOptions): Promise<{
    messageId: string;
    status: Promise<ProviderStatus>;
  }>;
  status?(messageId: string): Promise<ProviderStatus>;
  statusHandler?(request: Request): Response;
}
```

### `send` (required)

```typescript
async send(options: ProviderSendOptions) {
  // Render the template for the requested channel
  // Send the message through provider infrastructure
  return {
    messageId: '<provider-generated-id>',
    status: Promise.resolve({
      status: 'sent' | 'failed',
      timestamp: new Date(),
      details: { ... },
    }),
  };
}
```

### `status` (optional)

```typescript
async status(messageId: string): Promise<ProviderStatus> {
  // Fetch delivery status for a message
  // Return status from provider's status endpoint
}
```

### `statusHandler` (optional)

```typescript
async statusHandler(request: Request): Response {
  // Parse provider's delivery status webhook
  // Store the result in the shared state
}
```

## Provider Registration

Each provider should export its factory function from `index.ts`:

```typescript
export const myProviderFactory: ProviderFactory = {
  id: 'my-provider-id',
  create: (config) => new MyProvider(config.config, config.state),
};
```

## Built-in Providers

- `meta-whatsapp`: Meta WhatsApp Cloud API (template and text sends, signed status webhook)

## Built-in Providers (to be implemented)

- `twilio-sms`: Twilio SMS
- `vonage-sms`: Vonage SMS
- `gmail`: Gmail API (send with OAuth refresh token)
- `http-sms`: Generic HTTP SMS gateway skeleton
- `console`: Development mode, logs to console

## Adding a New Provider

1. Create `src/providers/<provider-id>/index.ts`
2. Implement the `Provider` contract
3. Export the factory:
   ```typescript
   export const <providerId>Factory: ProviderFactory = {
     id: '<provider-id>',
     create: (config) => new <ProviderName>(config.config, config.state),
   };
   ```
4. Register in `src/providers/register.ts`
5. Test against the integration test suite
6. Add to CI workflows
7. Submit a pull request

## Testing Guidelines

- **Provider stubs must not make network calls** - these are unit tests
- **Integration tests** should be in `test/integration/providers/`
- Use mock environment for local testing
- No message bodies in logs (enforced by linter)

## Provider Status Mapping

Map provider statuses to the standard `DeliveryStatus`:

| Provider Status                          | Mapped To        |
| ---------------------------------------- | ---------------- |
| `sent`                                   | `sent`           |
| `delivered`                              | `delivered`      |
| `read`                                   | `read`           |
| `failed`, `error`                        | `failed`         |
| `not_delivered`, `bounce`, `undelivered` | `undelivered`    |
| `undecipherable`, `blocked`              | `undecipherable` |
| `pending`, unknown                       | `unknown`        |

## Environment Variables

Each provider may require specific environment variables:

| Variable              | Description                   |
| --------------------- | ----------------------------- |
| `META_WHATSAPP_*`     | Meta WhatsApp API credentials |
| `TWILIO_ACCOUNT_SID`  | Twilio account SID            |
| `TWILIO_AUTH_TOKEN`   | Twilio auth token             |
| `TWILIO_ACCOUNT_SID`  | Vonage phone number           |
| `GMAIL_CLIENT_ID`     | Gmail OAuth client ID         |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth client secret     |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth refresh token     |

These should be passed in `ProviderConfig` or loaded from bindings.

## Security Notes

- **Never log message bodies** or template parameters
- **Never log credentials** or API tokens
- **Only log**: provider ID, channel, message ID, status, timestamp

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

- [ ] Implements `Provider` contract
- [ ] `send` method exists and is async
- [ ] Status method returns standard `DeliveryStatus`
- [ ] Webhook handler validates signature (if applicable)
- [ ] No hardcoded credentials
- [ ] Linting passes
- [ ] Type checking passes
- [ ] Unit tests pass
- [ ] Integration test exists (if applicable)
