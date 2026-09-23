# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-23

Hardens one-time-code delivery and makes the package installable. Built for a sign-in flow that sends codes over a WhatsApp authentication template with SMS fallback, in several locales, from another Worker.

### Added

- **Tarball releases**: every `v*` tag publishes `messagefall-workers-<version>.tgz` on its GitHub Release. Install it by URL, pinned, with no build step: `bun add messagefall-workers@https://github.com/nalinda/messagefall-workers/releases/download/v0.2.0/messagefall-workers-0.2.0.tgz`. CI proves each tarball installs with Bun and that every entry point imports.
- **WhatsApp authentication templates**: `whatsapp.authentication: true` sends the single code param as the body parameter and as the copy-code (one-tap) URL button parameter at index 0, the component pair Meta requires.
- **Encryption at rest**: with `MESSAGES_ENC_KEY` (32 bytes, base64), the render input stashed for fallback is encrypted with AES-256-GCM, bound to the message id, in both the `in:<id>` KV entry and the `FallbackTimer`'s storage.
- **`await: 'chain'`** on `send` (core, `POST /send` and `createMessagingClient`): waits for the synchronous chain walk, even for an `otp` send given an ExecutionContext, and reports `outcome: 'accepted'` (a provider accepted the message; not yet delivered) or `'undelivered'` (every channel failed immediately). The app answers `undelivered` with `502 { error, code: 'undelivered', id }`; the client returns `{ ok: false, status: 502, code: 'undelivered', id }`.
- **Shared secret for `/send` and `/status/:id`**: `createMessagingApp({ secret: (env) => ... })` requires the `x-messagefall-secret` header (constant-time comparison, fails closed with `500` when the secret is missing); `createMessagingClient({ secret })` sends it. Webhook routes stay public.
- **Failure codes**: `SendResult` and `StatusEvent` carry an optional content-free `code`, recorded on the attempt as `errorCode`. The built-in providers report `graph:<code>`, `http:<status>` and `network`.
- **Per-template `timeout`**, overriding the per-kind `delivery.timeout`.
- `NoTemplateLanguageError`, `EncryptionKeyError`, `OTP_ERROR_WITHHELD`, and the `SendOutcome` / `SendResponse` types on the root entry.

### Changed

- **Breaking:** a catalogue with a `kind: 'otp'` template requires `MESSAGES_ENC_KEY`. `createMessaging` throws `MessagingConfigError` without it and `validateEnv` reports it; a malformed key is reported whenever one is set.
- **Breaking:** an `otp` status record never stores a vendor's error text, on the send path or from a webhook. Its `error` is `OTP_ERROR_WITHHELD` and `errorCode` carries the code. `notification` errors are scrubbed as before.
- **Breaking:** a locale missing from a WhatsApp template's `language` map, with no `default`, now throws `NoTemplateLanguageError`: the WhatsApp attempt is recorded `failed` with `errorCode: 'no-template-language'` without calling Meta, and the chain moves to the next channel. (It was a generic render error before, with the same effect on the chain.)

### Fixed

- The two 0.1.0 known limitations: the one-time code is no longer stored in plaintext, and a bare-value OTP parameter can no longer leak into a status record through a vendor error.

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
- **Webhook Dispatch**: Provider-owned webhook verification and ingestion routes (`/webhooks/<provider>`) that correlate external delivery receipts back to original message IDs and advance fallback chains.
- **Hono Application**: Ready-to-use HTTP app wrapper (`createMessagingApp`) exposing endpoints for message sending (`/send`), delivery status queries (`/status/:id`), and provider webhooks. Published as its own entry point, `messagefall-workers/app`, so the root entry never resolves the optional `hono` peer dependency.
- **Typed Client**: `createMessagingClient` for type-safe Worker-to-Worker messaging across Cloudflare Service Bindings, sharing the template catalog.
- **Structured Logging & Redaction**: Built-in JSON logger whose fields are a closed allow-list of identifiers and telemetry, so one-time passwords (OTPs), message bodies and template parameters cannot be passed to a log line at all; vendor error strings, which can quote that content back, are scrubbed separately before they are logged or persisted on a status record.
- **Example Worker**: Minimal standalone reference implementation under `examples/basic` demonstrating full multi-provider configuration with local development simulation.
- **Integration Tests**: Comprehensive test suite using Miniflare and `wrangler dev` verifying end-to-end send pipelines, webhook callbacks, and fallback behaviors.

### Known limitations

- The render input the fallback chain needs (`in:<id>` in KV) is stored **unencrypted** for the duration of the chain timeout. For an OTP template that payload contains the code in plaintext. Encrypting it is deferred past 0.1.0; see the README's Delivery status section.
- Vendor error strings on a `failed` webhook are scrubbed against that same `in:<id>` entry. Once it expires (the chain timeout, floor 60s) the status record itself lives on for 7 days, and scrubbing falls back to recovering values from the literal text the template renders around each parameter. A parameter that renders a **bare value with no surrounding literal text** — the shape the README's OTP example uses, `params: (i) => [i.code]` — offers nothing to anchor on, so it is skipped rather than redacting the whole error string. A vendor that quotes the code back in an error arriving after that window can therefore persist it unredacted on a record `GET /status/:id` serves. Give OTP parameters some surrounding literal text, or do not serve `/status/:id` to untrusted callers.
