/**
 * Hono application integration for messagefall-workers.
 *
 * @module
 */

import { Hono, type MiddlewareHandler } from 'hono';

import { normalizeBasePath } from '../core/base-path.js';
import {
  createMessaging,
  type MessagingOptions,
  type SendArgs,
  UnknownTemplateError,
} from '../core/messaging.js';
import { PolicyError } from '../core/policy.js';
import { EmailRecipientError, RecipientError, type SendContext } from '../core/send.js';
import { announceTimerOff, registerMessagingOptions } from '../core/timer.js';
import { errorMessage, isRecord } from '../core/values.js';
import { type MessagingEnv, validateEnv } from '../env.js';
import { TemplateValidationError } from '../templates.js';

/**
 * The request header a caller presents the shared secret in. `createMessagingClient` sets it.
 */
export const SECRET_HEADER = 'x-messagefall-secret';

/**
 * Compares two strings without an early exit that would let response time reveal how much of a
 * guess was right. Both sides are hashed first, so the comparison always walks 32 bytes whatever
 * the lengths.
 */
async function isSecretMatch(given: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let diff = 0;
  for (const [i, byte] of left.entries()) {
    diff |= byte ^ (right.at(i) ?? 0);
  }
  return diff === 0;
}

function getExecutionContext(c: { executionCtx: unknown }): SendContext | undefined {
  try {
    return c.executionCtx as SendContext;
  } catch {
    return undefined;
  }
}

function isMissingSendFields(body: Record<string, unknown>): boolean {
  return !body.template || !body.to || !body.locale || body.input === undefined;
}

function isNamedError(err: unknown, name: string): boolean {
  return isRecord(err) && err.name === name;
}

/**
 * Which HTTP status each send fault maps to. Matched by constructor first and by `name` second,
 * so an error that crossed a module boundary (a second copy of the package in the graph, a
 * structured-clone across a service binding) is still classified rather than becoming a 500.
 */
const SEND_ERROR_STATUS: ReadonlyArray<{
  type: new (...args: never[]) => Error;
  status: 400 | 404 | 422;
}> = [
  { type: UnknownTemplateError, status: 404 },
  { type: PolicyError, status: 422 },
  { type: TemplateValidationError, status: 400 },
  { type: RecipientError, status: 400 },
  { type: EmailRecipientError, status: 400 },
];

function mapSendError(err: unknown): { status: 400 | 404 | 422; message: string } | null {
  const match = SEND_ERROR_STATUS.find(
    ({ type }) => err instanceof type || isNamedError(err, type.name)
  );
  return match ? { status: match.status, message: errorMessage(err) } : null;
}

/**
 * Creates a ready-to-deploy Hono messaging application.
 *
 * @param options - Messaging application configuration options.
 * @returns A typed Hono application serving /send, /status/:id, and /webhooks/:provider.
 */
export function createMessagingApp<E extends MessagingEnv = MessagingEnv>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: MessagingOptions<any> & {
    basePath?: string;
    /**
     * Returns the shared secret `/send` and `/status/:id` require in the
     * `x-messagefall-secret` header (pass the same value to `createMessagingClient`'s
     * `secret`). When set, a request without the matching header gets `401`, and a function
     * that returns nothing makes both routes answer `500` rather than open. Webhook routes are
     * unaffected: they stay public and signature-verified.
     */
    secret?: (env: E) => string | undefined;
  }
): Hono<{ Bindings: E }> {
  const app = new Hono<{ Bindings: E }>();
  const prefix = normalizeBasePath(options.basePath);
  // The FallbackTimer Durable Object rebuilds the core from these options when its alarm fires,
  // which is why it must be exported from the Worker module that makes this call.
  registerMessagingOptions(options);

  let isValidated = false;

  // Startup validation executed once per isolate on first request
  app.use('*', async (c, next) => {
    if (!isValidated) {
      validateEnv(c.env, options);
      // Without the FALLBACK_TIMER binding chain fallback is driven by explicit failure
      // statuses only; said once per app so a missing binding is visible in the logs.
      announceTimerOff(c.env, options.timer, app);
      isValidated = true;
    }
    await next();
  });

  const { secret } = options;
  if (secret) {
    // Fails closed: a secret option whose value is missing at runtime locks the routes rather
    // than silently leaving them open.
    const guard: MiddlewareHandler<{ Bindings: E }> = async (c, next) => {
      const expected = secret(c.env);
      if (!expected) {
        return c.json({ error: 'Messaging secret is not configured' }, 500);
      }
      const given = c.req.header(SECRET_HEADER);
      if (given === undefined || !(await isSecretMatch(given, expected))) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    };
    app.use(`${prefix}/send`, guard);
    app.use(`${prefix}/status/*`, guard);
  }

  // POST <basePath>/send
  app.post(`${prefix}/send`, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON payload' }, 400);
    }

    if (!isRecord(body) || isMissingSendFields(body)) {
      return c.json({ error: 'Missing required send fields (template, to, locale, input)' }, 400);
    }

    const messaging = createMessaging(c.env, options);
    const ctx = getExecutionContext(c);

    try {
      const result = await messaging.send(
        {
          template: body.template as string,
          to: body.to as string,
          email: body.email as string | undefined,
          locale: body.locale as string,
          input: body.input,
          delivery: body.delivery as SendArgs<Record<string, unknown>, string>['delivery'],
          ...(body.await === 'chain' && { await: 'chain' }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as SendArgs<any, any>,
        ctx
      );
      if (result.outcome === 'undelivered') {
        // Every channel failed before anything was sent: a stable `code` the caller can act on.
        return c.json(
          { error: 'No channel accepted the message', code: 'undelivered', id: result.id },
          502
        );
      }
      return c.json(result, 200);
    } catch (err: unknown) {
      const mapped = mapSendError(err);
      if (mapped) {
        return c.json({ error: mapped.message }, mapped.status);
      }
      throw err;
    }
  });

  // GET <basePath>/status/:id
  app.get(`${prefix}/status/:id`, async (c) => {
    const id = c.req.param('id');
    const messaging = createMessaging(c.env, options);
    const record = await messaging.status(id);
    if (!record) {
      return c.json({ error: `Message record not found: ${id}` }, 404);
    }
    return c.json(record, 200);
  });

  // GET and POST <basePath>/webhooks/:provider
  app.on(['GET', 'POST'], `${prefix}/webhooks/:provider`, async (c) => {
    const provider = c.req.param('provider');
    const messaging = createMessaging(c.env, options);
    const ctx = getExecutionContext(c);
    return messaging.handleWebhook(provider, c.req.raw, ctx);
  });

  return app;
}
