/**
 * Meta WhatsApp API provider.
 *
 * @module
 */

import type {
  Provider,
  ProviderConfig,
  ProviderSendFn,
  ProviderStatusFn,
  ProviderStatus,
  ProviderFactory,
} from './types';
import type {
  Channel,
  TemplateDefinition,
  TemplateRendering,
  DeliveryPolicy,
  MessagingState,
  MessageStatus,
} from '../../types';
import type { MessageStatusEntry } from '../../store';

/**
 * Meta WhatsApp provider implementation.
 */
export class MetaWhatsappProvider implements Provider {
  readonly id = 'meta-whatsapp';
  readonly channel = 'whatsapp';

  constructor(
    private readonly config: {
      phoneId: string;
      accessToken: string;
      appId: string;
      templateName?: string;
    },
    private readonly state: MessagingState,
  ) {}

  send(options: ProviderSendOptions): Promise<{
    messageId: string;
    status: Promise<ProviderStatus>;
  }> {
    // TODO: Implement Meta WhatsApp API send
    // - https://developers.facebook.com/docs/whatsapp/business-api/send
    // - https://developers.facebook.com/docs/whatsapp/business-api/webhooks/delivery
    throw new Error('Not implemented');
  }

  status(messageId: string): Promise<ProviderStatus> {
    // TODO: Implement Meta WhatsApp API status fetch
    // - https://developers.facebook.com/docs/whatsapp/business-api/webhooks/delivery
    throw new Error('Not implemented');
  }

  statusHandler(request: Request): Response {
    // TODO: Handle Meta delivery status webhooks
    // - https://developers.facebook.com/docs/whatsapp/business-api/webhooks/delivery
    throw new Error('Not implemented');
  }
}

export const metaWhatsappFactory: ProviderFactory = {
  id: 'meta-whatsapp',
  create: (config) => new MetaWhatsappProvider(config.config, config.state),
};
