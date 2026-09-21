/**
 * Console provider implementation.
 *
 * Dispatches messages to standard console logging, suppressing sensitive OTP bodies.
 *
 * @module
 */

import type {
  Channel,
  OutboundMeta,
  Provider,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  SendResult,
  StatusEvent,
  WebhookParseOptions,
} from '../types.js';

export type ConsoleRendered =
  RenderedSms | RenderedWhatsApp | RenderedEmail | Record<string, unknown>;

/**
 * Loggable name for `message.template`, which may be a string or a WhatsApp config (#28).
 */
function templateLabel(template: unknown): string {
  if (typeof template === 'string') {
    return template;
  }
  if (template && typeof template === 'object' && 'name' in template) {
    return String(template.name);
  }
  return String(template);
}

type ConsoleStatusBody = {
  providerId?: string;
  id?: string;
  status: StatusEvent['status'];
  error?: string;
  at?: string;
};

/**
 * Configuration options for creating a console provider.
 */
export interface ConsoleProviderOptions {
  /**
   * Delivery channel this console provider operates on.
   */
  channel: Channel;
  /**
   * Optional unique name for this provider instance (defaults to 'console').
   */
  name?: string;
  /**
   * Optional status simulation configuration.
   */
  simulate?: {
    /**
     * Status to simulate ('delivered' or 'failed').
     */
    status: 'delivered' | 'failed';
    /**
     * Delay in milliseconds before firing the simulated status event.
     */
    afterMs: number;
  };
  /**
   * Optional webhook handler for delivery status updates.
   */
  webhook?: {
    /**
     * Handshake verification.
     */
    verify?(request: Request): Promise<Response | null>;
    /**
     * Parse webhook delivery status payload into status events.
     */
    parse: (request: Request, options?: WebhookParseOptions) => Promise<StatusEvent[]>;
  };
}

/**
 * Creates a console provider instance that logs outbound messages to the console.
 *
 * When sending an OTP message (`kind === 'otp'`), the rendered message body is
 * omitted from log output to prevent secret disclosure.
 *
 * @param options - Console provider configuration options.
 * @returns A Provider instance for console logging.
 */
export function consoleProvider<R = ConsoleRendered>(
  options: ConsoleProviderOptions
): Provider<R> & {
  onSimulatedStatus?: (event: StatusEvent) => void;
} {
  const providerName = options.name ?? 'console';
  const providerChannel = options.channel;

  const provider: Provider<R> & {
    onSimulatedStatus?: (event: StatusEvent) => void;
  } = {
    name: providerName,
    channel: providerChannel,
    send: (message: R & OutboundMeta): Promise<SendResult> => {
      const { to, messageId, kind } = message;
      const template = templateLabel(message.template);

      if (kind === 'otp') {
        console.log(
          `[${providerName}] [${providerChannel}] to=${to} template=${template} messageId=${messageId} [otp body redacted]`
        );
      } else {
        console.log(
          `[${providerName}] [${providerChannel}] to=${to} template=${template} messageId=${messageId}`
        );
      }

      const providerId = `console_${messageId}`;

      if (options.simulate) {
        const { status, afterMs } = options.simulate;
        setTimeout(() => {
          provider.onSimulatedStatus?.({
            providerId,
            status,
            at: new Date().toISOString(),
          });
        }, afterMs);
      }

      return Promise.resolve({
        ok: true,
        providerId,
      });
    },
    webhook: options.webhook ?? {
      parse: async (request: Request): Promise<StatusEvent[]> => {
        const body = (await request.json()) as ConsoleStatusBody | ConsoleStatusBody[];
        const items = Array.isArray(body) ? body : [body];
        const at = new Date().toISOString();
        return items.map((item) => ({
          providerId: item.providerId ?? item.id ?? '',
          status: item.status,
          ...(item.error !== undefined && { error: item.error }),
          at: item.at ?? at,
        }));
      },
    },
  };

  return provider;
}

export default consoleProvider;
