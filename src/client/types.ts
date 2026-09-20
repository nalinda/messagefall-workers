/**
 * Client types for messaging.
 */

/**
 * Client message type.
 */
export type ClientMessageType = 'text' | 'otp';

/**
 * Client messaging options.
 */
export interface MessagingClientOptions {
  app: { fetch: (request: Request) => Response };
  channel?: ClientMessageType;
}

/**
 * Client message status.
 */
export type ClientMessageStatus =
  | { status: 'sent'; timestamp: string; channels: ClientMessageType[] }
  | { status: 'pending'; timestamp: string; timeoutMs: number }
  | { status: 'delivered'; timestamp: string; provider?: string }
  | { status: 'failed'; timestamp: string; error: string };
