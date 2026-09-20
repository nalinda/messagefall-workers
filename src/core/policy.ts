/**
 * Delivery policy types and pure resolution logic.
 *
 * @module
 */

import type { Channel } from '../providers/types.js';

/**
 * Concrete delivery policy specifying fallback chain and parallel always-on channels.
 */
export interface DeliveryPolicy {
  fallback: Channel[];
  always: Channel[];
}

/**
 * Partial override for delivery policy or 'all' shorthand.
 */
export type DeliveryOverride = Partial<DeliveryPolicy> | 'all';

/**
 * Default delivery policy: WhatsApp first, then SMS; no always-on channels.
 */
export const DEFAULT_POLICY: DeliveryPolicy = {
  fallback: ['whatsapp', 'sms'],
  always: [],
};

/**
 * Arguments for resolving delivery policy.
 */
export interface ResolveDeliveryArgs {
  defaults: DeliveryPolicy;
  template?: DeliveryOverride;
  send?: DeliveryOverride;
  defined: Channel[];
  templateName?: string;
}

/**
 * Error thrown when a delivery policy resolves to no available channels for a template.
 */
export class PolicyError extends Error {
  readonly templateName?: string;
  readonly defaults: DeliveryPolicy;
  readonly template?: DeliveryOverride;
  readonly send?: DeliveryOverride;
  readonly defined: Channel[];
  readonly beforeFilter: DeliveryPolicy;

  constructor(args: {
    templateName?: string;
    defaults: DeliveryPolicy;
    template?: DeliveryOverride;
    send?: DeliveryOverride;
    defined: Channel[];
    beforeFilter: DeliveryPolicy;
    message?: string;
  }) {
    const templateLabel = args.templateName ? ` "${args.templateName}"` : '';
    const msg =
      args.message ??
      `No delivery channels available for template${templateLabel}. Defined: [${args.defined.join(
        ', '
      )}], resolved before filtering: fallback=[${args.beforeFilter.fallback.join(
        ', '
      )}], always=[${args.beforeFilter.always.join(', ')}]`;
    super(msg);
    this.name = 'PolicyError';
    this.templateName = args.templateName;
    this.defaults = args.defaults;
    this.template = args.template;
    this.send = args.send;
    this.defined = args.defined;
    this.beforeFilter = args.beforeFilter;
  }
}

function normalizeOverride(
  override: DeliveryOverride | undefined,
  defined: Channel[]
): Partial<DeliveryPolicy> | undefined {
  if (override === 'all') {
    return { fallback: [], always: [...defined] };
  }
  return override;
}

function deduplicateChannels(channels: Channel[], exclude?: Set<Channel>): Channel[] {
  const result: Channel[] = [];
  const seen = new Set<Channel>();
  for (const ch of channels) {
    if (seen.has(ch) || exclude?.has(ch)) {
      continue;
    }
    seen.add(ch);
    result.push(ch);
  }
  return result;
}

/**
 * Resolves the effective delivery policy across defaults, template override, and send override.
 *
 * Rules:
 * 1. Precedence, most specific wins: `send`, then `template`, then `defaults`. Each level may set
 *    `fallback`, `always`, or both; an unset part inherits from the next level.
 * 2. `'all'` at any level resolves to `{ fallback: [], always: defined }` and stops inheritance for both parts.
 * 3. A channel present in both parts is removed from `fallback` and kept in `always`.
 * 4. Channels not in `defined` are dropped from both parts, preserving order.
 * 5. If both parts are empty after step 4, throws `PolicyError` with the template name, the three inputs,
 *    and the result before filtering.
 *
 * @param args - The resolution arguments.
 * @returns The resolved delivery policy.
 * @throws {PolicyError} If no channels remain in either fallback or always.
 */
export function resolveDelivery(args: ResolveDeliveryArgs): DeliveryPolicy {
  const { defaults, template, send, defined, templateName } = args;

  // Rule 2: Expand 'all' at each level if present
  const sendResolved = normalizeOverride(send, defined);
  const templateResolved = normalizeOverride(template, defined);

  // Rule 1: Precedence - send > template > defaults for each part independently
  const rawFallback = sendResolved?.fallback ?? templateResolved?.fallback ?? defaults.fallback;
  const rawAlways = sendResolved?.always ?? templateResolved?.always ?? defaults.always;

  // Rule 3: Deduplicate and ensure channel present in both parts is kept in always only
  const always = deduplicateChannels(rawAlways);
  const fallback = deduplicateChannels(rawFallback, new Set(always));

  const beforeFilter: DeliveryPolicy = { fallback, always };

  // Rule 4: Channels not in defined are dropped from both parts, preserving order
  const definedSet = new Set<Channel>(defined);
  const finalFallback = fallback.filter((ch) => definedSet.has(ch));
  const finalAlways = always.filter((ch) => definedSet.has(ch));

  // Rule 5: If both parts are empty after step 4, throw PolicyError
  if (finalFallback.length === 0 && finalAlways.length === 0) {
    throw new PolicyError({
      templateName,
      defaults,
      template,
      send,
      defined,
      beforeFilter,
    });
  }

  return {
    fallback: finalFallback,
    always: finalAlways,
  };
}
