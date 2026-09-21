/**
 * Typed template catalog definition, validation, and channel rendering.
 *
 * @module
 */

import type { DeliveryOverride } from './core/policy.js';
import type {
  Channel,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
  TemplateKind,
} from './providers/types.js';
import type { StandardSchemaIssue, StandardSchemaV1 } from './types.js';

/**
 * Locale identifier string (e.g. 'en', 'si', 'ta').
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases
export type Locale = string;

/**
 * Any rendered message payload.
 */
export type AnyRendered = RenderedWhatsApp | RenderedSms | RenderedEmail;

/**
 * WhatsApp template configuration options.
 */
export type WhatsAppTemplateConfig<In> =
  | {
      template: string;
      language: string | Record<Locale, string>;
      params: (input: In, locale: Locale) => string[];
      text?: never;
    }
  | {
      text: (input: In, locale: Locale) => string;
      template?: never;
      language?: never;
      params?: never;
    };

/**
 * Email template configuration options.
 */
export interface EmailTemplateConfig<In> {
  subject: (input: In, locale: Locale) => string;
  text: (input: In, locale: Locale) => string;
  html?: (input: In, locale: Locale) => string;
}

/**
 * Template definition for a typed template catalog.
 */
export interface TemplateDef<In = unknown> {
  input: StandardSchemaV1<unknown, In>;
  kind: TemplateKind;
  whatsapp?: WhatsAppTemplateConfig<In>;
  sms?: (input: In, locale: Locale) => string;
  email?: EmailTemplateConfig<In>;
  delivery?: DeliveryOverride;
}

/**
 * Extract the inferred input type from a template catalog definition.
 */
export type InputOf<T, K extends keyof T> = T[K] extends TemplateDef<infer In> ? In : never;

/**
 * Typed template catalog return type.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Templates<
  T extends Record<string, TemplateDef<any>> = Record<string, TemplateDef<any>>,
> = {
  readonly [K in keyof T]: T[K];
};
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Validation error thrown when input fails schema validation.
 */
export class TemplateValidationError extends Error {
  readonly issues: readonly StandardSchemaIssue[];

  constructor(message: string, issues: readonly StandardSchemaIssue[] = []) {
    super(message);
    this.name = 'TemplateValidationError';
    this.issues = issues;
  }
}

function isStandardSchema(schema: unknown): schema is StandardSchemaV1<unknown, unknown> {
  if (!schema || (typeof schema !== 'object' && typeof schema !== 'function')) return false;
  if (!('~standard' in schema)) return false;
  const standard: unknown = schema['~standard'];
  return (
    !!standard &&
    typeof standard === 'object' &&
    typeof (standard as { validate?: unknown }).validate === 'function'
  );
}

/**
 * Assert a template's `input` really is a Standard Schema validator. `input` is required on every
 * template, so this is what a JavaScript caller (or a cast) hits instead of silently skipping
 * validation.
 *
 * @param schema - The value supplied as a template's `input`.
 * @throws {TypeError} If it is not a Standard Schema validator.
 */
function assertStandardSchema(schema: unknown): void {
  if (!isStandardSchema(schema)) {
    throw new TypeError('Template "input" must be a Standard Schema validator');
  }
}

function hasWhatsAppChannel(wa: unknown): boolean {
  if (!wa || typeof wa !== 'object') return false;
  if ('template' in wa && typeof wa.template === 'string' && wa.template.length > 0) {
    return true;
  }
  return 'text' in wa && typeof wa.text === 'function';
}

function hasSmsChannel(sms: unknown): boolean {
  return typeof sms === 'function';
}

function hasEmailChannel(email: unknown): boolean {
  if (!email || typeof email !== 'object') return false;
  const e = email as Record<string, unknown>;
  return typeof e.subject === 'function' && typeof e.text === 'function';
}

/**
 * Returns the list of delivery channels defined for a template.
 *
 * @param def - The template definition.
 * @returns Array of channel names defined on the template.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function definedChannels<In = any>(def: TemplateDef<In>): Channel[] {
  const channels: Channel[] = [];
  if (hasWhatsAppChannel(def.whatsapp)) {
    channels.push('whatsapp');
  }
  if (hasSmsChannel(def.sms)) {
    channels.push('sms');
  }
  if (hasEmailChannel(def.email)) {
    channels.push('email');
  }
  return channels;
}

function validateDeliveryChannels(
  templateName: string,
  delivery: DeliveryOverride,
  channels: readonly Channel[]
): void {
  if (delivery === 'all') return;
  const listToCheck = [...(delivery.fallback ?? []), ...(delivery.always ?? [])];
  for (const ch of listToCheck) {
    if (!channels.includes(ch)) {
      throw new Error(`Template "${templateName}" delivery references undefined channel "${ch}"`);
    }
  }
}

/**
 * Meta requires an authentication template for one-time codes, so an `otp` template may not
 * render WhatsApp through free-form `whatsapp.text`.
 *
 * The rule is enforced both at catalogue definition time ({@link defineTemplates}, `validateEnv`)
 * and again per send, so this is the one statement of it.
 *
 * @param templateName - Template name, for the error message.
 * @param def - The template definition to check.
 * @throws {Error} If an `otp` template defines `whatsapp.text`.
 */
export function assertNoOtpWhatsAppText(templateName: string, def: TemplateDef<unknown>): void {
  if (
    def.kind === 'otp' &&
    def.whatsapp &&
    'text' in def.whatsapp &&
    typeof def.whatsapp.text === 'function'
  ) {
    throw new Error(
      `Template "${templateName}" of kind "otp" must not use whatsapp.text (Meta requires an authentication template for codes)`
    );
  }
}

/**
 * Validates one template definition: it declares an `input` Standard Schema, it renders at least
 * one channel, an `otp` template does not use `whatsapp.text`, and any `delivery` override only
 * names channels the template defines.
 *
 * @param templateName - Template name, for the error messages.
 * @param def - The template definition to validate.
 * @throws {Error} On the first problem found.
 */
export function validateTemplateDef(templateName: string, def: TemplateDef<unknown>): void {
  if (!isStandardSchema(def.input)) {
    throw new Error(`Template "${templateName}" must define an "input" Standard Schema validator`);
  }
  const channels = definedChannels(def);
  if (channels.length === 0) {
    throw new Error(`Template "${templateName}" must define at least one channel rendering`);
  }
  assertNoOtpWhatsAppText(templateName, def);
  if (def.delivery) {
    validateDeliveryChannels(templateName, def.delivery, channels);
  }
}

/**
 * Define and validate a type-safe template catalog at definition time.
 *
 * Validations:
 * 1. Each template must define an `input` Standard Schema validator.
 * 2. Each template must define at least one channel rendering.
 * 3. kind: 'otp' must not use whatsapp.text (Meta requires authentication templates).
 * 4. delivery overrides must only name channels defined by the template.
 *
 * @param defs - Record of template definitions.
 * @returns The typed template catalog.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineTemplates<T extends Record<string, TemplateDef<any>>>(defs: T): Templates<T> {
  for (const [templateName, def] of Object.entries(defs)) {
    validateTemplateDef(templateName, def as TemplateDef<unknown>);
  }
  return defs;
}

function formatIssuePath(path?: StandardSchemaIssue['path']): string {
  if (!path || path.length === 0) return '';
  return path
    .map((seg) => String(typeof seg === 'object' && 'key' in seg ? seg.key : seg))
    .join('.');
}

/**
 * Validate a raw input payload against a template's schema without rendering. Returns the
 * schema's output so callers can hand the transformed value to {@link renderValidated} exactly
 * once.
 *
 * The caller's schema is the only rule. This package deliberately adds none of its own — an
 * OTP's code format and length are the caller's concern, not ours.
 *
 * @param def - Template definition.
 * @param input - Input payload before validation.
 * @returns The validated (and possibly transformed) input.
 * @throws {TemplateValidationError} If the input fails the schema.
 */
export function validateInput<In>(def: TemplateDef<In>, input: unknown): In {
  return validateSchema(def, input);
}

function validateSchema<In>(def: TemplateDef<In>, input: unknown): In {
  assertStandardSchema(def.input);
  const result = def.input['~standard'].validate(input);
  if (result instanceof Promise) {
    throw new TypeError('Async validation is not supported in synchronous render()');
  }
  if (result.issues) {
    const summary = result.issues
      .map((issue) => {
        const pathStr = formatIssuePath(issue.path);
        return pathStr ? `${pathStr}: ${issue.message}` : issue.message;
      })
      .join(', ');
    throw new TemplateValidationError(
      `Template input validation failed: ${summary}`,
      result.issues
    );
  }
  return result.value;
}

function resolveWhatsAppLanguage(
  language: string | Record<string, string>,
  locale: Locale,
  templateName: string
): string {
  if (typeof language === 'string') {
    return language;
  }
  const langMap = new Map<string, string>(Object.entries(language));
  if (langMap.has(locale)) {
    return langMap.get(locale)!;
  }
  if (langMap.has('default')) {
    return langMap.get('default')!;
  }
  throw new Error(
    `Missing language mapping for locale "${locale}" in WhatsApp template "${templateName}" and no default language configured`
  );
}

function renderWhatsApp<In>(
  wa: WhatsAppTemplateConfig<In> | undefined,
  input: In,
  locale: Locale
): RenderedWhatsApp {
  if (!wa) {
    throw new Error('WhatsApp configuration is missing');
  }
  if ('template' in wa && typeof wa.template === 'string' && wa.template.length > 0) {
    const lang = resolveWhatsAppLanguage(wa.language, locale, wa.template);
    return {
      templateConfig: {
        name: wa.template,
        language: lang,
        params: wa.params(input, locale),
      },
    };
  }
  if ('text' in wa && typeof wa.text === 'function') {
    return {
      text: wa.text(input, locale),
    };
  }
  throw new Error('Invalid WhatsApp template configuration');
}

function renderSms<In>(
  sms: ((input: In, locale: Locale) => string) | undefined,
  input: In,
  locale: Locale
): RenderedSms {
  if (typeof sms !== 'function') {
    throw new TypeError('SMS configuration is missing');
  }
  return {
    text: sms(input, locale),
  };
}

function renderEmail<In>(
  email: EmailTemplateConfig<In> | undefined,
  input: In,
  locale: Locale
): RenderedEmail {
  if (!email || typeof email.subject !== 'function' || typeof email.text !== 'function') {
    throw new Error('Email configuration is missing');
  }
  const subject = email.subject(input, locale);
  const text = email.text(input, locale);
  const html = typeof email.html === 'function' ? email.html(input, locale) : undefined;
  return {
    subject,
    text,
    ...(html !== undefined && { html }),
  };
}

/**
 * Render a template for a specific channel with input validation and locale resolution.
 *
 * @param def - Template definition.
 * @param channel - Channel to render for.
 * @param input - Input payload before validation.
 * @param locale - Target locale identifier.
 * @returns Rendered channel payload.
 */
export function render<In = unknown>(
  def: TemplateDef<In>,
  channel: Channel,
  input: unknown,
  locale: Locale
): RenderedWhatsApp | RenderedSms | RenderedEmail {
  return renderValidated(def, channel, validateInput(def, input), locale);
}

/**
 * Render a template for a specific channel from input that {@link validateInput} has already
 * accepted. Skips validation so a transforming schema is applied exactly once per send.
 *
 * @param def - Template definition.
 * @param channel - Channel to render for.
 * @param validatedInput - Output of {@link validateInput} for this template.
 * @param locale - Target locale identifier.
 * @returns Rendered channel payload.
 */
export function renderValidated<In = unknown>(
  def: TemplateDef<In>,
  channel: Channel,
  validatedInput: In,
  locale: Locale
): RenderedWhatsApp | RenderedSms | RenderedEmail {
  const channels = definedChannels(def as TemplateDef<unknown>);
  if (!channels.includes(channel)) {
    throw new Error(`Channel "${channel}" is not defined on this template`);
  }

  switch (channel) {
    case 'whatsapp': {
      return renderWhatsApp(def.whatsapp, validatedInput, locale);
    }
    case 'sms': {
      return renderSms(def.sms, validatedInput, locale);
    }
    case 'email': {
      return renderEmail(def.email, validatedInput, locale);
    }
    default: {
      const _exhaustiveCheck: never = channel;
      throw new Error(`Unsupported channel: ${String(_exhaustiveCheck)}`);
    }
  }
}
