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
    const ttlSeconds = Math.max(expiresIn - 60, 1);

    inMemoryToken = data.access_token;
    inMemoryExpiresAt = Date.now() + ttlSeconds * 1000;

    if (options.tokenCache) {
      const key = await getCacheKey();
      await options.tokenCache.put(key, data.access_token, {
        expirationTtl: ttlSeconds,
      });
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
