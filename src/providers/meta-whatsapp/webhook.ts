/**
 * Meta WhatsApp Cloud API webhook: subscription handshake and signed status parsing.
 *
 * @module
 */

import type { DeliveryStatus, StatusEvent } from '../types.js';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';
const STATUSES: ReadonlySet<string> = new Set<DeliveryStatus>([
  'sent',
  'delivered',
  'read',
  'failed',
]);

const encoder = new TextEncoder();

/**
 * Answer the Meta subscription handshake.
 *
 * Returns `200` with `hub.challenge` when `hub.mode=subscribe` and
 * `hub.verify_token` matches, `403` for any other GET, and `null` for
 * non-GET requests so that `parse` handles them.
 */
export function verifyHandshake(request: Request, verifyToken: string): Response | null {
  if (request.method !== 'GET') return null;

  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token !== null && isEqualConstantTimeText(token, verifyToken)) {
    return new Response(challenge ?? '', {
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

interface WebhookStatus {
  id?: unknown;
  status?: unknown;
  timestamp?: unknown;
  errors?: { title?: unknown }[];
}

interface WebhookPayload {
  entry?: { changes?: { value?: { statuses?: WebhookStatus[] } }[] }[];
}

function toIsoTimestamp(timestamp: unknown): string {
  const seconds = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    return new Date(seconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

function toStatusEvent(status: WebhookStatus): StatusEvent | null {
  if (typeof status.id !== 'string' || typeof status.status !== 'string') return null;
  if (!STATUSES.has(status.status)) return null;

  const event: StatusEvent = {
    providerId: status.id,
    status: status.status as DeliveryStatus,
    at: toIsoTimestamp(status.timestamp),
  };

  const title = status.errors?.[0]?.title;
  if (typeof title === 'string') event.error = title;

  return event;
}

/**
 * Map a webhook payload's `entry[].changes[].value.statuses[]` to status
 * events. Changes without statuses (for example inbound messages) yield nothing.
 */
export function parseStatuses(payload: unknown): StatusEvent[] {
  const entries = (payload as WebhookPayload | null)?.entry;
  if (!Array.isArray(entries)) return [];

  const statuses = entries
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change.value?.statuses ?? []);
  return statuses
    .map((status) => toStatusEvent(status))
    .filter((event): event is StatusEvent => event !== null);
}

/**
 * Verify the request signature and parse its statuses into events.
 *
 * @throws On a missing or mismatched signature, or a body that is not JSON.
 */
export async function parseSignedStatuses(
  request: Request,
  appSecret: string
): Promise<StatusEvent[]> {
  const body = await verifySignedBody(request, appSecret);
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error('meta-whatsapp: webhook body is not valid JSON');
  }
  return parseStatuses(payload);
}
