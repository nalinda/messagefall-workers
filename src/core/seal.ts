/**
 * Encryption at rest for the render input: the one piece of message content this package has to
 * keep between requests.
 *
 * The fallback chain re-renders a message on its next channel from the input the caller passed to
 * `send`, so that input is stashed under `in:<id>` in KV and in the fallback timer's Durable Object
 * storage. For a one-time code that input *is* the code. When the deployment supplies
 * `MESSAGES_ENC_KEY` the template input is sealed with AES-256-GCM before either write and only
 * opened at the two places that need the plaintext back: the fallback advance that re-renders it,
 * and the webhook scrubber that redacts it from a vendor error.
 *
 * The ciphertext is bound to its message id, recipient and locale as additional authenticated
 * data. Those fields sit beside it in the clear (the fallback path needs no key to read them), so
 * binding them is what stops a sealed input from being opened for a different message, or for
 * a recipient rewritten in KV: either fails to open rather than sending someone's code to someone
 * else.
 *
 * @module
 */

import type { MessagingEnv } from '../env.js';
import { hasOtpTemplate } from '../templates.js';
import { DEFAULT_LOCALE } from './render-input.js';

/**
 * The env binding holding the key: 32 random bytes, base64-encoded
 * (`openssl rand -base64 32`).
 */
export const ENC_KEY_BINDING = 'MESSAGES_ENC_KEY';

const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * What a sealed input is bound to: the message and the fields stored beside it that decide where
 * and how the opened input is sent.
 */
export interface SealContext {
  id: string;
  to?: string;
  email?: string;
  locale?: string;
}

/**
 * The additional data for a context. `locale` is normalised to the one default every path
 * renders with (`DEFAULT_LOCALE`): the timer fills a missing locale in when it is armed while the
 * KV entry leaves it out, so binding the raw value would make the two copies of one input
 * disagree and the timed fallback fail to open it.
 */
function additionalData(context: SealContext): Uint8Array<ArrayBuffer> {
  const { id, to, email, locale } = context;
  const bound = [id, to ?? null, email ?? null, locale ?? DEFAULT_LOCALE];
  return new TextEncoder().encode(JSON.stringify(bound));
}

/**
 * A template input as it is stored once sealed. Recognised by its `$sealed` field, which no
 * caller's input is expected to carry at top level.
 */
export interface SealedInput {
  $sealed: {
    /**
     * Envelope version, so the format can change without misreading older entries.
     */
    v: 1;
    /**
     * Base64 AES-GCM nonce.
     */
    iv: string;
    /**
     * Base64 ciphertext with the GCM tag appended.
     */
    ct: string;
  };
}

/**
 * Thrown for a key that is present but unusable (not base64, or not 32 bytes).
 */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.codePointAt(0) ?? 0);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
}

/**
 * Why a raw key value cannot be used, or `undefined` when it can. Shared by startup validation
 * and {@link importSealKey}, so the two cannot disagree about what a valid key is.
 *
 * @param raw - The binding's value.
 * @returns A problem description, or undefined.
 */
export function sealKeyProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return `${ENC_KEY_BINDING} must be a non-empty base64 string`;
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(raw.trim());
  } catch {
    return `${ENC_KEY_BINDING} is not valid base64`;
  }
  return bytes.length === KEY_BYTES
    ? undefined
    : `${ENC_KEY_BINDING} must decode to ${KEY_BYTES} bytes (got ${bytes.length}); generate one with \`openssl rand -base64 32\``;
}

/**
 * What is wrong with a deployment's key configuration, or `undefined` when nothing is: the key is
 * required when the catalogue has an `otp` template, and must be well-formed whenever it is set.
 * The one statement of the rule, shared by `createMessaging` (which throws on it) and
 * `validateEnv` (which collects it with every other startup problem).
 *
 * @param env - Worker bindings.
 * @param templates - The template catalogue.
 * @returns A problem description, or undefined.
 */
export function sealKeyConfigProblem(env: unknown, templates: unknown): string | undefined {
  const raw = rawSealKey(env);
  if (raw !== undefined) {
    return sealKeyProblem(raw);
  }
  const catalogue = templates && typeof templates === 'object' ? templates : undefined;
  return hasOtpTemplate(catalogue as Parameters<typeof hasOtpTemplate>[0])
    ? `Missing required secret ${ENC_KEY_BINDING}: the catalogue has an otp template, whose code the fallback chain stores encrypted`
    : undefined;
}

/**
 * Imports the AES-GCM key from its base64 form, memoised per value for the isolate.
 *
 * @param raw - The base64 key.
 * @returns The imported key.
 * @throws {EncryptionKeyError} If the value is not a 32-byte base64 key.
 */
export function importSealKey(raw: string): Promise<CryptoKey> {
  const problem = sealKeyProblem(raw);
  if (problem) {
    return Promise.reject(new EncryptionKeyError(problem));
  }
  let key = keyCache.get(raw);
  if (!key) {
    key = crypto.subtle.importKey('raw', fromBase64(raw.trim()), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    keyCache.set(raw, key);
  }
  return key;
}

/**
 * The seal key for an env, or `undefined` when the deployment configures none.
 *
 * @param env - Worker bindings.
 * @returns The imported key, or undefined.
 * @throws {EncryptionKeyError} If the binding is set but malformed.
 */
export async function sealKeyFor(
  env: Pick<MessagingEnv, string> | undefined
): Promise<CryptoKey | undefined> {
  const raw = rawSealKey(env);
  return raw === undefined ? undefined : importSealKey(raw as string);
}

/**
 * The key binding's raw value, or `undefined` when it is absent or empty (no key configured).
 * The one read of the binding, shared by {@link sealKeyFor}, `createMessaging` and `validateEnv`.
 *
 * @param env - Worker bindings, or anything else.
 * @returns The raw value, unvalidated.
 */
export function rawSealKey(env: unknown): unknown {
  if (!env || typeof env !== 'object') return undefined;
  const raw: unknown = Reflect.get(env, ENC_KEY_BINDING);
  return raw === '' ? undefined : raw;
}

/**
 * Whether a stored value is a {@link SealedInput}.
 */
export function isSealed(value: unknown): value is SealedInput {
  if (!value || typeof value !== 'object' || !('$sealed' in value)) return false;
  const sealed = value.$sealed;
  if (!sealed || typeof sealed !== 'object') return false;
  const { v, iv, ct } = sealed as { v?: unknown; iv?: unknown; ct?: unknown };
  return v === 1 && typeof iv === 'string' && typeof ct === 'string';
}

/**
 * Seals a template input for one message. With no key the input is returned unchanged, which is
 * how a deployment without `MESSAGES_ENC_KEY` behaves (only allowed when it has no `otp`
 * template).
 *
 * @param key - The seal key, or undefined.
 * @param context - Message id, recipient and locale, bound to the ciphertext as additional data.
 * @param input - The template input.
 * @returns The sealed envelope, or the input itself when there is no key.
 */
export async function sealInput(
  key: CryptoKey | undefined,
  context: SealContext,
  input: unknown
): Promise<unknown> {
  if (!key) {
    return input;
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(input ?? null));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(context) },
    key,
    plaintext
  );
  const sealed: SealedInput = {
    $sealed: { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) },
  };
  return sealed;
}

/**
 * The outcome of opening a stored input: the plaintext, or the fact that it could not be opened
 * (no key, a rotated key, or an envelope bound to another message).
 */
export type OpenedInput = { ok: true; input: unknown } | { ok: false };

/**
 * Opens a stored template input. A value that was never sealed is returned as it is.
 *
 * @param key - The seal key, or undefined.
 * @param context - Message id, recipient and locale the envelope must be bound to: the values
 * stored beside it, exactly as they will be used.
 * @param stored - The stored value.
 * @returns The plaintext input, or `{ ok: false }` when a sealed value cannot be opened.
 */
export async function openInput(
  key: CryptoKey | undefined,
  context: SealContext,
  stored: unknown
): Promise<OpenedInput> {
  if (!isSealed(stored)) {
    return { ok: true, input: stored };
  }
  if (!key) {
    return { ok: false };
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(stored.$sealed.iv),
        additionalData: additionalData(context),
      },
      key,
      fromBase64(stored.$sealed.ct)
    );
    return { ok: true, input: JSON.parse(new TextDecoder().decode(plaintext)) as unknown };
  } catch {
    return { ok: false };
  }
}
