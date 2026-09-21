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
  async function cacheToken(accessToken: string, ttlSeconds: number): Promise<void> {
    try {
      const key = await getCacheKey();
      await options.tokenCache?.put(key, accessToken, { expirationTtl: ttlSeconds });
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

    inMemoryToken = data.access_token;
    inMemoryExpiresAt = Date.now() + lifetimeSeconds * 1000;

    if (options.tokenCache) {
      // Floored at KV's own minimum, which the usable life can fall below for a short-lived
      // token. A cached entry outliving the token by up to a minute is harmless: the send path
      // invalidates and re-exchanges on a 401, which is exactly what an expired one produces.
      const ttlSeconds = Math.max(lifetimeSeconds, KV_MIN_EXPIRATION_TTL);
      await cacheToken(data.access_token, ttlSeconds);
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
        const cached = await options.tokenCache.get(key);
        if (cached !== null) {
          inMemoryToken = cached;
          inMemoryExpiresAt = Date.now() + 60 * 1000;
          return cached;
        }
      }

      return exchangeRefreshToken();
    },

    async invalidate(): Promise<void> {
      inMemoryToken = null;
      inMemoryExpiresAt = 0;
      if (options.tokenCache) {
        const key = await getCacheKey();
        await options.tokenCache.delete(key);
      }
    },
  };
}
