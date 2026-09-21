/**
 * Meta WhatsApp Cloud API webhook: subscription handshake and signed status parsing.
 *
 * @module
 */

import { parseStatuses } from '../_shared/meta-statuses.js';
import type { StatusEvent } from '../types.js';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

const encoder = new TextEncoder();

/**
 * Answer the Meta subscription handshake.
 *
 * Returns `200` with `hub.challenge` when `hub.mode=subscribe`,
 * `hub.verify_token` matches and `hub.challenge` is present; `403` for any
 * other GET (including a matching token with no challenge); and `null` for
 * non-GET requests so that `parse` handles them.
 */
export function verifyHandshake(request: Request, verifyToken: string): Response | null {
  if (request.method !== 'GET') return null;

  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (
    mode === 'subscribe' &&
    token !== null &&
    challenge !== null &&
    isEqualConstantTimeText(token, verifyToken)
  ) {
    return new Response(challenge, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  return new Response('Forbidden', { status: 403 });
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const pairs = hex.match(/.{2}/g) ?? [];
  return Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
}

/**
 * Compare two byte arrays without short-circuiting on the first difference,
 * so the comparison time does not reveal where the inputs diverge.
 */
function isEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (const [index, byte] of a.entries()) {
    diff |= byte ^ (b.at(index) ?? 0);
  }
  return diff === 0;
}

function isEqualConstantTimeText(a: string, b: string): boolean {
  return isEqualConstantTime(encoder.encode(a), encoder.encode(b));
}

/**
 * Compute the HMAC-SHA256 of `body` with `secret` using Web Crypto.
 */
async function hmacSha256(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return new Uint8Array(signature);
}

/**
 * Verify `X-Hub-Signature-256` against the raw body and return the body.
 *
 * @throws When the header is missing, malformed, or does not match.
 */
export async function verifySignedBody(request: Request, appSecret: string): Promise<string> {
  const header = request.headers.get(SIGNATURE_HEADER);
  if (header === null) {
    throw new Error(`meta-whatsapp: missing ${SIGNATURE_HEADER} header`);
  }
  if (!header.startsWith(SIGNATURE_PREFIX)) {
    throw new Error(`meta-whatsapp: malformed ${SIGNATURE_HEADER} header`);
  }

  const provided = hexToBytes(header.slice(SIGNATURE_PREFIX.length));
  if (provided === null) {
    throw new Error(`meta-whatsapp: malformed ${SIGNATURE_HEADER} header`);
  }

  const body = await request.text();
  const expected = await hmacSha256(appSecret, body);
  if (!isEqualConstantTime(provided, expected)) {
    throw new Error('meta-whatsapp: webhook signature mismatch');
  }
  return body;
}

export { parseStatuses } from '../_shared/meta-statuses.js';

function parseBody(body: string): StatusEvent[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error('meta-whatsapp: webhook body is not valid JSON');
  }
  return parseStatuses(payload);
}

/**
 * Verify the request signature and parse its statuses into events.
 *
 * @param request - The incoming webhook request.
 * @param appSecret - App secret the `X-Hub-Signature-256` header is checked against.
 * @returns The status events in the payload.
 * @throws On a missing or mismatched signature, or a body that is not JSON.
 */
export async function parseSignedStatuses(
  request: Request,
  appSecret: string
): Promise<StatusEvent[]> {
  return parseBody(await verifySignedBody(request, appSecret));
}

/**
 * Parse a webhook payload WITHOUT verifying its signature.
 *
 * Only for the documented local-development bypass: the dispatcher sets
 * `WebhookParseOptions.devUnsigned` solely when `MESSAGING_DEV_UNSIGNED=true` and the request
 * arrived on localhost, because a vendor webhook cannot reach a developer's machine to be
 * signed in the first place.
 *
 * @param request - The incoming webhook request.
 * @returns The status events in the payload.
 * @throws On a body that is not JSON.
 */
export async function parseUnsignedStatuses(request: Request): Promise<StatusEvent[]> {
  return parseBody(await request.text());
}
