/**
 * Console provider implementation.
 *
 * Dispatches messages to standard console logging, suppressing sensitive OTP bodies.
 *
 * @module
 */

// The one Meta parser, shared with the Meta provider rather than copied. The console provider is
// what the example Worker and the integration suite run against, so a second implementation here
// meant local testing stopped predicting production the moment the two drifted — which happened.
import { parseStatuses as parseMetaStatuses } from '../_shared/meta-statuses.js';
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
      const { to, messageId, kind, template } = message;

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
      parse: async (
        request: Request,
        parseOptions?: WebhookParseOptions
      ): Promise<StatusEvent[]> => {
        if (parseOptions?.devUnsigned !== true) {
          throw new Error('console: unsigned webhooks disabled without dev bypass');
        }
        const body: unknown = await request.json();
        if (body && typeof body === 'object' && 'entry' in body) {
          return parseMetaStatuses(body);
        }
        const items = Array.isArray(body)
          ? (body as ConsoleStatusBody[])
          : [body as ConsoleStatusBody];
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
