/**
 * The per-channel provider set: normalising one and validating it.
 *
 * This is the single place the provider-slot rules live. `createMessaging` calls
 * {@link validateProviderSet} to fail fast on a bad set; `validateEnv` calls
 * {@link providerSetProblems} to fold the same problems into its one startup report; the
 * asynchronous fallback path calls {@link toProviderSet} for the set it was handed.
 *
 * @module
 */

import { CHANNELS, type Provider } from '../providers/types.js';
import type { ProviderSet } from './send.js';

/**
 * Thrown when the provider set built from env is invalid.
 */
export class ProviderConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    const bullets = problems.map((problem) => `- ${problem}`).join('\n');
    super(`Provider configuration validation failed:\n${bullets}`);
    this.name = 'ProviderConfigError';
    this.problems = problems;
  }
}

const KNOWN_SLOTS: ReadonlySet<string> = new Set(CHANNELS);

function missingProviderFields(p: Partial<Provider>): string[] {
  const missing: string[] = [];
  if (typeof p.name !== 'string' || p.name.length === 0) missing.push('name');
  if (typeof p.channel !== 'string' || p.channel.length === 0) missing.push('channel');
  if (typeof p.send !== 'function') missing.push('send');
  return missing;
}

/**
 * Problems with one provider in isolation: unknown slot, missing fields, channel/slot mismatch.
 *
 * @param slot - The key the provider is registered under.
 * @param p - The candidate provider.
 * @returns One message per problem; empty when the slot is sound.
 */
function slotProblems(slot: string, p: Partial<Provider>): string[] {
  const problems: string[] = [];
  if (!KNOWN_SLOTS.has(slot)) {
    // Same union `providerFor` switches on; anything else could never be sent through.
    problems.push(
      `Provider slot "${slot}" is not a channel (expected one of ${CHANNELS.join(', ')})`
    );
  }
  const missing = missingProviderFields(p);
  if (missing.length > 0) {
    problems.push(`Provider "${slot}" is missing required field(s): ${missing.join(', ')}`);
  }
  if (p.channel && p.channel !== slot) {
    problems.push(
      `Provider "${slot}" declares channel "${p.channel}" but is registered under the "${slot}" slot`
    );
  }
  return problems;
}

/**
 * Every problem with a provider set: each slot in isolation, plus names repeated across slots.
 *
 * @param set - The provider set, keyed by channel slot. Absent entries are ignored.
 * @returns One message per problem; empty when the set is sound.
 */
export function providerSetProblems(set: object): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [slot, candidate] of Object.entries(set)) {
    if (!candidate) {
      continue;
    }
    const p = candidate as Partial<Provider>;
    problems.push(...slotProblems(slot, p));
    if (typeof p.name === 'string' && p.name.length > 0) {
      if (seen.has(p.name)) {
        problems.push(`Duplicate provider name "${p.name}" configured across multiple providers`);
      }
      seen.add(p.name);
    }
  }
  return problems;
}

/**
 * Asserts a provider set is usable, or reports every problem at once.
 *
 * @param set - The provider set to check.
 * @throws {ProviderConfigError} If the set has any problem.
 */
export function validateProviderSet(set: object): void {
  const problems = providerSetProblems(set);
  if (problems.length > 0) {
    throw new ProviderConfigError(problems);
  }
}

/**
 * The provider set for an advance, with "no providers configured" flattened to an empty set.
 *
 * There is only one shape to accept: `MessagingOptions.providers` is `(env) => ProviderSet`, and
 * every internal caller hands on the already-resolved set. A channel with no provider is simply
 * an absent slot, which the pipeline records as a failed attempt rather than dispatching nowhere.
 *
 * @param providers - The resolved provider set, if there is one.
 * @returns The provider set, keyed by channel slot.
 */
export function toProviderSet(providers: ProviderSet | undefined): ProviderSet {
  return providers ?? {};
}
