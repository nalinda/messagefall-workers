/**
 * Hono application integration for messagefall-workers.
 *
 * @module
 */

import { Hono } from 'hono';

import { createLogger } from '../core/logger.js';
import {
  createMessaging,
  type MessagingOptions,
  type SendArgs,
  UnknownTemplateError,
} from '../core/messaging.js';
import { PolicyError } from '../core/policy.js';
import { RecipientError, type SendContext } from '../core/send.js';
import { resolveTimer } from '../core/status.js';
import { registerMessagingOptions } from '../core/timer.js';
import { type MessagingEnv, validateEnv } from '../env.js';
import { TemplateValidationError } from '../templates.js';

const logger = createLogger();

function getExecutionContext(c: { executionCtx: unknown }): SendContext | undefined {
  try {
    return c.executionCtx as SendContext;
  } catch {
    return undefined;
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

function isMissingSendFields(body: Record<string, unknown>): boolean {
  return !body.template || !body.to || !body.locale || body.input === undefined;
}

function isNamedError(err: unknown, name: string): boolean {
  return isRecord(err) && err.name === name;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mapSendError(err: unknown): { status: 400 | 404 | 422; message: string } | null {
  if (err instanceof UnknownTemplateError || isNamedError(err, 'UnknownTemplateError')) {
    return { status: 404, message: errorMessage(err) };
  }
  if (err instanceof PolicyError || isNamedError(err, 'PolicyError')) {
    return { status: 422, message: errorMessage(err) };
  }
  if (
    err instanceof TemplateValidationError ||
    isNamedError(err, 'TemplateValidationError') ||
    err instanceof RecipientError ||
    isNamedError(err, 'RecipientError')
  ) {
    return { status: 400, message: errorMessage(err) };
  }
  return null;
}

function normalizeBasePath(basePath?: string): string {
  if (!basePath) return '';
  const trimmed = basePath.trim();
  const withoutLeading = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const withoutTrailing = withoutLeading.endsWith('/')
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  return withoutTrailing ? `/${withoutTrailing}` : '';
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
      if (!resolveTimer(c.env, options.timer)) {
        // Without the FALLBACK_TIMER binding chain fallback is driven by explicit failure
        // statuses only; said once per app so a missing binding is visible in the logs.
        logger.info('timer.off');
      }
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
    const ctx = getExecutionContext(c);
    if (
      ctx &&
      'promises' in ctx &&
      Array.isArray((ctx as unknown as { promises: Promise<unknown>[] }).promises)
    ) {
      await Promise.all((ctx as unknown as { promises: Promise<unknown>[] }).promises);
    }
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
