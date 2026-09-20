/**
 * Stub client implementation for development.
 */

/**
 * Stub client for testing.
 */
export class StubClient {
  async send(templateId: string, input: unknown, channel?: ClientMessageType): Promise<ClientMessageStatus> {
    return {
      status: 'sent',
      timestamp: new Date().toISOString(),
      channels: channel || ['whatsapp', 'sms', 'email'],
    };
  }
}
