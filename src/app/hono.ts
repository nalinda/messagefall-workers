/**
 * Hono application integration for messagefall-workers.
 *
 * @module
 */

import { Hono } from 'hono';

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
  options: MessagingOptions<any> & { basePath?: string }
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as SendArgs<any, any>,
        ctx
      );
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
