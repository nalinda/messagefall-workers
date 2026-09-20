/**
 * Test doubles for createMessagingClient specifications (Issue #12).
 *
 * The client types and factory are imported directly from src/client/index.js
 * by the tests; only the Fetcher double and the rejection helper live here.
 *
 * @module
 */

import type { Fetcher } from '@cloudflare/workers-types';

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
