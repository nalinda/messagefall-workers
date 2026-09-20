/**
 * The per-channel provider set: normalising one and validating it.
 *
 * This is the single place the provider-slot rules live. `createMessaging` calls
 * {@link validateProviderSet} to fail fast on a bad set; `validateEnv` calls
 * {@link providerSetProblems} to fold the same problems into its one startup report; the
 * asynchronous fallback path calls {@link toProviderSet} to turn whatever shape a caller
 * configured providers in back into the slots the send pipeline reads.
 *
 * @module
 */

import { type Channel, CHANNELS, type Provider } from '../providers/types.js';
import type { AnyRendered } from '../templates.js';
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
 * Every shape a caller may configure providers in: the per-channel {@link ProviderSet} itself,
 * a factory building one from the env, or a loose collection the slots have to be recovered
 * from by each provider's own `channel`.
 */
export type ProviderSource<Env = unknown> =
  | Record<string, Provider>
  | Provider[]
  | Map<string, Provider>
  | ProviderSet
  | ((env: Env) => ProviderSet);

function findInMap(
  providers: Map<string, Provider>,
  channel: Channel
): Provider<AnyRendered> | undefined {
  for (const p of providers.values()) {
    if (p.channel === channel) return p;
  }
  return undefined;
}

function findInObject(
  providers: Record<string, unknown>,
  channel: Channel
): Provider<AnyRendered> | undefined {
  for (const p of Object.values(providers)) {
    if (p && typeof p === 'object' && 'channel' in p && p.channel === channel) {
      return p as Provider<AnyRendered>;
    }
  }
  return undefined;
}

function findProviderForChannel<Env>(
  providers: ProviderSource<Env> | undefined,
  env: Env,
  channel: Channel
): Provider<AnyRendered> | undefined {
  if (!providers) return undefined;
  const resolved = typeof providers === 'function' ? providers(env) : providers;
  if (resolved instanceof Map) {
    return findInMap(resolved, channel);
  }
  if (Array.isArray(resolved)) {
    return resolved.find((p) => p.channel === channel);
  }
  if (typeof resolved === 'object') {
    return findInObject(resolved as Record<string, unknown>, channel);
  }
  return undefined;
}

/**
 * Normalises whatever shape the caller configured providers in into the per-channel
 * {@link ProviderSet} the send pipeline expects. A slot is filled from the first provider
 * declaring that channel; channels with no provider are left absent, which the pipeline records
 * as a failed attempt rather than dispatching nowhere.
 *
 * @param providers - The configured providers, in any supported shape.
 * @param env - Worker bindings, for a provider factory.
 * @returns The provider set, keyed by channel slot.
 */
export function toProviderSet<Env>(
  providers: ProviderSource<Env> | undefined,
  env: Env
): ProviderSet {
  const slots = CHANNELS.map(
    (channel) => [channel, findProviderForChannel(providers, env, channel)] as const
  ).filter(([, provider]) => provider !== undefined);
  return Object.fromEntries(slots);
}
