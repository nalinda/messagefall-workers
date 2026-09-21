/**
 * OAuth2 token exchange and caching for Gmail API.
 *
 * Handles exchanging OAuth refresh tokens for short-lived access tokens,
 * in-memory caching per isolate with a 60-second expiry safety buffer,
 * and optional cross-isolate caching in Cloudflare KV.
 *
 * @module
 */

import type { KVNamespace } from '@cloudflare/workers-types';

import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * KV's minimum `expirationTtl`, in seconds. A shorter value is rejected outright, so a token
 * whose remaining life is under a minute would otherwise make the cache write throw.
 */
const KV_MIN_EXPIRATION_TTL = 60;

/**
 * Options required for Google OAuth2 token exchange.
 */
export interface GmailOAuthOptions {
  /**
   * OAuth 2.0 Client ID.
   */
  clientId: string;
  /**
   * OAuth 2.0 Client Secret.
   */
  clientSecret: string;
  /**
   * OAuth 2.0 Refresh Token.
   */
  refreshToken: string;
  /**
   * Optional Cloudflare KV namespace for cross-isolate token caching.
   */
  tokenCache?: KVNamespace;
}

/**
 * Manager interface for retrieving and invalidating OAuth access tokens.
 */
export interface GmailTokenManager {
  /**
   * Retrieves a valid access token, exchanging refresh token if needed.
   */
  getToken(): Promise<string>;
  /**
   * Invalidates any cached access tokens in memory and KV.
   */
  invalidate(): Promise<void>;
}

/**
 * Computes a SHA-256 cache key for the given client ID and refresh token.
 */
async function computeCacheKey(clientId: string, refreshToken: string): Promise<string> {
  const data = new TextEncoder().encode(`${clientId}:${refreshToken}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = [...new Uint8Array(hashBuffer)];
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `gmail:token:${hashHex}`;
}

/**
 * What the cross-isolate cache holds: the token plus the epoch-millisecond instant it stops being
 * usable. The expiry travels with the token because the KV entry's own TTL cannot carry it — it is
 * floored at {@link KV_MIN_EXPIRATION_TTL}, so a short-lived token's entry deliberately outlives
 * the token, and a reader with only the bare string had no way to tell.
 */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Reads a cache entry, or null when it is absent, unparseable or already past its expiry. A value
 * this function cannot vouch for is treated as a miss: re-exchanging the refresh token is cheap
 * and always correct.
 */
function parseCachedToken(raw: string | null): CachedToken | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { token, expiresAt } = parsed as Partial<CachedToken>;
  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    return null;
  }
  return Date.now() < expiresAt ? { token, expiresAt } : null;
}

/**
 * Creates a token manager instance for the provided OAuth credentials.
 *
 * @param options - Gmail OAuth credentials and optional KV cache.
 * @returns Token manager instance.
 */
export function createGmailTokenManager(options: GmailOAuthOptions): GmailTokenManager {
  let inMemoryToken: string | null = null;
  let inMemoryExpiresAt = 0;
  let cacheKeyPromise: Promise<string> | null = null;

  function getCacheKey(): Promise<string> {
    if (!cacheKeyPromise) {
      cacheKeyPromise = computeCacheKey(options.clientId, options.refreshToken);
    }
    return cacheKeyPromise;
  }

  /**
   * Writes the freshly exchanged token to the cross-isolate cache. Best effort, deliberately:
   * by the time this runs a valid access token is already in hand and in memory, so a rejected
   * KV write must not turn a successful exchange into a thrown one — the caller would report a
   * retryable send failure for a send that could have gone out. The only cost of a lost write
   * is that the next isolate exchanges the refresh token again.
   */
  async function cacheToken(entry: CachedToken, ttlSeconds: number): Promise<void> {
    try {
      const key = await getCacheKey();
      await options.tokenCache?.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds });
    } catch (error) {
      logger.warn('provider.token-cache-failed', {
        provider: 'gmail',
        errorCode: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  async function exchangeRefreshToken(): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      let errorMsg = text;
      try {
        const json = JSON.parse(text) as {
          error_description?: string;
          error?: string | { message?: string };
        };
        if (json.error_description) {
          errorMsg = json.error_description;
        } else if (typeof json.error === 'string') {
          errorMsg = json.error;
        } else if (json.error?.message) {
          errorMsg = json.error.message;
        }
      } catch {
        // use raw response text
      }
      throw new Error(`Gmail OAuth token exchange failed (${res.status}): ${errorMsg}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    // The token's usable life, with a safety buffer for clock skew and the request in flight.
    const lifetimeSeconds = Math.max(expiresIn - 60, 1);

    const expiresAt = Date.now() + lifetimeSeconds * 1000;
    inMemoryToken = data.access_token;
    inMemoryExpiresAt = expiresAt;

    if (options.tokenCache) {
      // Floored at KV's own minimum, which the usable life can fall below for a short-lived
      // token. A cached entry outliving the token by up to a minute is harmless: the stored
      // `expiresAt` is what the reader honours, and the send path invalidates and re-exchanges on
      // a 401 in any case.
      const ttlSeconds = Math.max(lifetimeSeconds, KV_MIN_EXPIRATION_TTL);
      await cacheToken({ token: data.access_token, expiresAt }, ttlSeconds);
    }

    return data.access_token;
  }

  return {
    async getToken(): Promise<string> {
      if (inMemoryToken !== null && Date.now() < inMemoryExpiresAt) {
        return inMemoryToken;
      }

      if (options.tokenCache) {
        const key = await getCacheKey();
        const cached = parseCachedToken(await options.tokenCache.get(key));
        if (cached) {
          // Pinned in memory to the token's own remaining life, not a flat 60s: a fixed pin on
          // top of the KV entry's floored TTL could serve a short-lived token for the best part
          // of two minutes past expiry, costing a 401 and a re-exchange on every send in that
          // window.
          inMemoryToken = cached.token;
          inMemoryExpiresAt = cached.expiresAt;
          return cached.token;
        }
      }

      return exchangeRefreshToken();
    },

    /**
     * Drops the rejected token, in memory and from the cross-isolate cache.
     *
     * The delete is best effort for the same reason {@link cacheToken}'s write is, and with a
     * sharper edge: `send` calls this from the one `await` outside its own try block, so a
     * rejecting KV delete would propagate out of the provider, be flattened into a plain
     * `{ ok: false, error }` with no `retryable`, and move the chain to the next channel instead
     * of retrying with a fresh token — the very failure a 401 refresh exists to avoid. The
     * in-memory token is already cleared above, so the retry re-exchanges either way; a lost
     * delete only costs another isolate one 401.
     */
    async invalidate(): Promise<void> {
      inMemoryToken = null;
      inMemoryExpiresAt = 0;
      if (options.tokenCache) {
        try {
          const key = await getCacheKey();
          await options.tokenCache.delete(key);
        } catch (error) {
          logger.warn('provider.token-cache-failed', {
            provider: 'gmail',
            errorCode: error instanceof Error ? error.name : 'UnknownError',
          });
        }
      }
    },
  };
}
