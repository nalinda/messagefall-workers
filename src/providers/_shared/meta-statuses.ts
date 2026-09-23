/**
 * The Meta WhatsApp Cloud API status-payload parser.
 *
 * It lives here rather than beside the Meta provider because two providers parse this shape: the
 * Meta provider itself, from a signed webhook body, and the console provider, which accepts a
 * Meta-shaped body so local development and the integration suite exercise the same parse the
 * vendor's callbacks take. Keeping one implementation is the point — a second copy drifted from
 * this one, and it was the copy the examples ran against.
 *
 * Nothing in here touches the network or the Graph API, so importing it does not pull the Meta
 * provider into another entry point's bundle.
 *
 * @module
 */

import type { DeliveryStatus, StatusEvent } from '../types.js';

const STATUSES: ReadonlySet<string> = new Set<DeliveryStatus>([
  'sent',
  'delivered',
  'read',
  'failed',
]);

interface WebhookStatus {
  id?: unknown;
  status?: unknown;
  timestamp?: unknown;
  errors?: { title?: unknown; code?: unknown }[];
}

interface WebhookPayload {
  entry?: { changes?: { value?: { statuses?: WebhookStatus[] } }[] }[];
}

/**
 * Convert a Meta epoch-seconds `timestamp` to ISO, or `null` when it is
 * missing, not numeric, or outside the `Date` range. The caller falls back
 * to the receipt time so a status whose `id` and `status` are known is
 * never lost over a malformed timestamp.
 */
function toIsoTimestamp(timestamp: unknown): string | null {
  // `Number('')` is 0, so an empty or whitespace-only string must be rejected
  // before coercion rather than silently becoming the epoch.
  if (typeof timestamp === 'string' && timestamp.trim().length === 0) return null;
  const seconds = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  // Values beyond the Date range produce an invalid Date whose toISOString()
  // throws; report it as unusable instead of rejecting the whole batch.
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toStatusEvent(status: WebhookStatus): StatusEvent | null {
  if (typeof status.id !== 'string' || typeof status.status !== 'string') return null;
  if (!STATUSES.has(status.status)) return null;
  // A `failed` status with a malformed timestamp is still a failure the core
  // must hear about; only a missing `id` leaves nothing to correlate against.
  const at = toIsoTimestamp(status.timestamp) ?? new Date().toISOString();

  const event: StatusEvent = {
    providerId: status.id,
    status: status.status as DeliveryStatus,
    at,
  };

  const title = status.errors?.[0]?.title;
  if (typeof title === 'string') event.error = title;
  const code = status.errors?.[0]?.code;
  if (typeof code === 'number') event.code = `graph:${code}`;

  return event;
}

/**
 * Map a webhook payload's `entry[].changes[].value.statuses[]` to status
 * events. Changes without statuses (for example inbound messages) yield nothing.
 *
 * @param payload - The parsed webhook body.
 * @returns The status events it carries.
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
