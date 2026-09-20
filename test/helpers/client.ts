/**
 * Test helpers and type mirrors for createMessagingClient specifications (Issue #12).
 *
 * @module
 */

import type { Fetcher } from '@cloudflare/workers-types';

import type { MessageRecord } from '../../src/core/status.js';
import type { InputOf, Templates } from '../../src/templates.js';

/**
 * Narrowed channel names defined by a template definition.
 */
export type DefinedChannelsOf<Def> =
  | (Def extends { whatsapp: unknown } ? 'whatsapp' : never)
  | (Def extends { sms: unknown } ? 'sms' : never)
  | (Def extends { email: unknown } ? 'email' : never);

/**
 * Narrows fallback and always delivery overrides to the channels template K defines, or 'all'.
 */
export type DeliveryOverrideFor<T, K extends keyof T> =
  | 'all'
  | {
      fallback?: DefinedChannelsOf<T[K]>[];
      always?: DefinedChannelsOf<T[K]>[];
    };

/**
 * Arguments for client send.
 */
export interface ClientSendArgs<T, K extends keyof T> {
  to: string;
  email?: string;
  locale: string;
  input: InputOf<T, K>;
  delivery?: DeliveryOverrideFor<T, K>;
}

/**
 * Result returned by client send.
 */
export type ClientSendResult =
  | { ok: true; id: string }
  | { ok: false; status: number; error: string };

/**
 * Options for creating a messaging client.
 */
export interface CreateMessagingClientOptions {
  binding: Fetcher;
  basePath?: string;
}

/**
 * Typed client returned by createMessagingClient.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MessagingClient<T extends Templates<any> = Templates<any>> {
  send<K extends keyof T & string>(
    template: K,
    args: ClientSendArgs<T, K>
  ): Promise<ClientSendResult>;
  status(id: string): Promise<MessageRecord | null>;
}

/**
 * Function signature for createMessagingClient.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CreateMessagingClientFn = <T extends Templates<any> = Templates<any>>(
  options: CreateMessagingClientOptions
) => MessagingClient<T>;

/**
 * Mock Fetcher interface that records requests for inspection.
 */
export interface MockFetcher extends Fetcher {
  readonly requests: Request[];
}

/**
 * Creates a mock Fetcher for testing client requests over a service binding.
 *
 * @param handler - Function resolving each intercepted Request to a Response.
 * @returns A MockFetcher instance recording requests.
 */
export function createMockFetcher(
  handler: (request: Request) => Promise<Response> | Response
): MockFetcher {
  const requests: Request[] = [];

  const fetcher: Fetcher = {
    fetch: (async (input: unknown, init?: unknown): Promise<Response> => {
      const req =
        input instanceof Request
          ? input.clone()
          : new Request(String(input), init as RequestInit | undefined);
      requests.push(req.clone());
      return handler(req);
    }) as unknown as Fetcher['fetch'],
    connect: () => {
      throw new Error('connect not supported on MockFetcher');
    },
  };

  return Object.assign(fetcher, { requests });
}

/**
 * Awaits a promise and returns its rejection error, or throws if the promise resolves.
 */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Promise did not reject');
}

/**
 * Dynamically loads createMessagingClient from src/client/index.js if implemented,
 * or falls back to a dummy stub in the RED phase so tests execute real assertions
 * and fail for the right reason.
 *
 * @returns CreateMessagingClientFn implementation or stub.
 */
export async function loadCreateMessagingClient(): Promise<CreateMessagingClientFn> {
  try {
    const clientEntry = '../../src/client/index.js';
    const mod = (await import(clientEntry)) as unknown as {
      createMessagingClient?: CreateMessagingClientFn;
    };
    if (typeof mod.createMessagingClient === 'function') {
      return mod.createMessagingClient;
    }
  } catch {
    // client/index.js not yet implemented (RED phase)
  }

  try {
    const rootEntry = '../../src/index.js';
    const root = (await import(rootEntry)) as unknown as {
      createMessagingClient?: CreateMessagingClientFn;
    };
    if (typeof root.createMessagingClient === 'function') {
      return root.createMessagingClient;
    }
  } catch {
    // index.js does not export createMessagingClient yet
  }

  // Fallback dummy stub for RED phase
  return (_options: CreateMessagingClientOptions) => {
    return {
      send: () => Promise.resolve({ ok: false, status: 501, error: 'Not Implemented' }),
      status: () => Promise.resolve(null),
    };
  };
}
