# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-21

Initial release of `messagefall-workers`: an outbound messaging library for Cloudflare Workers featuring WhatsApp-first delivery with automatic SMS fallback, parallel always-on channels, typed templates, delivery-status webhooks, and Worker-to-Worker client bindings.

### Added

- **Send Pipeline**: Core messaging orchestrator (`createMessaging`) managing multi-channel message dispatch, sequential fallback chains, and parallel always-on channels with per-message and per-template policy overrides.
- **Fallback Chain**: Automatic advancement to subsequent delivery channels (e.g. WhatsApp → SMS) triggered by failed delivery status webhooks or timer timeouts until the chain is exhausted.
- **Timed Fallback**: Durable Object alarm-based timer (`FallbackTimer`) enabling reliable, stateful timeouts and fallback progression across Worker isolate lifecycles without persistent HTTP connections.
- **Typed Templates**: Compile-time input validation and type safety with `defineTemplates`, supporting per-channel renderers (WhatsApp templates, SMS text, multi-part HTML/text email) and parameter rendering without runtime schema library dependencies.
- **Providers**:
  - `meta-whatsapp`: Meta Cloud API provider for WhatsApp Business Platform template messaging and webhook signature verification (`/providers/meta-whatsapp`).
  - `http-sms`: Configurable HTTP SMS gateway provider supporting custom endpoints, authentication headers, and JSON/form payloads (`/providers/http-sms`).
  - `gmail`: Direct OAuth-authenticated Gmail API provider for outbound email (`/providers/gmail`).
  - `console`: Development provider with terminal output, webhook event simulation, and bypass support (`/providers/console`).
  - `stub`: In-memory test provider contract implementation for unit testing (`/providers/stub`).
- **Webhook Dispatch**: Provider-owned webhook verification and ingestion routes (`/webhooks/<provider>`) that correlate external delivery receipts back to original message IDs and advance fallback chains.
- **Hono Application**: Ready-to-use HTTP app wrapper (`createMessagingApp`) exposing endpoints for message sending (`/send`), delivery status queries (`/status/:id`), and provider webhooks. Published as its own entry point, `messagefall-workers/app`, so the root entry never resolves the optional `hono` peer dependency.
- **Typed Client**: `createMessagingClient` for type-safe Worker-to-Worker messaging across Cloudflare Service Bindings, sharing the template catalog.
- **Structured Logging & Redaction**: Built-in JSON logger with automatic parameter and code redaction ensuring one-time passwords (OTPs) and sensitive bodies are never leaked to logs.
- **Example Worker**: Minimal standalone reference implementation under `examples/basic` demonstrating full multi-provider configuration with local development simulation.
- **Integration Tests**: Comprehensive test suite using Miniflare and `wrangler dev` verifying end-to-end send pipelines, webhook callbacks, and fallback behaviors.

### Known limitations

- The render input the fallback chain needs (`in:<id>` in KV) is stored **unencrypted** for the duration of the chain timeout. For an OTP template that payload contains the code in plaintext. Encrypting it is deferred past 0.1.0; see the README's Delivery status section.
