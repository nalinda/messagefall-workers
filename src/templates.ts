/**
 * Typed template catalog definition, validation, and channel rendering.
 *
 * @module
 */

import type { DeliveryOverride } from './core/policy.js';
import type { Channel, RenderedEmail, RenderedSms, RenderedWhatsApp } from './providers/types.js';
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
  input?: StandardSchemaV1<unknown, In>;
  kind: 'otp' | 'notification';
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

function validateTemplateDef(templateName: string, def: TemplateDef<unknown>): void {
  const channels = definedChannels(def);
  if (channels.length === 0) {
    throw new Error(`Template "${templateName}" must define at least one channel rendering`);
  }
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
  if (def.delivery) {
    validateDeliveryChannels(templateName, def.delivery, channels);
  }
}

/**
 * Define and validate a type-safe template catalog at definition time.
 *
 * Validations:
 * 1. Each template must define at least one channel rendering.
 * 2. kind: 'otp' must not use whatsapp.text (Meta requires authentication templates).
 * 3. delivery overrides must only name channels defined by the template.
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
 * Validate a raw input payload against a template's schema (and the OTP code length rule)
 * without rendering. Returns the schema's output so callers can hand the transformed value to
 * {@link renderValidated} exactly once.
 *
 * @param def - Template definition.
 * @param input - Input payload before validation.
 * @returns The validated (and possibly transformed) input.
 * @throws {TemplateValidationError} If the input fails the schema.
 */
export function validateInput<In>(def: TemplateDef<In>, input: unknown): In {
  const validated = validateSchema(def, input);
  validateOtpCode(def.kind, validated);
  return validated;
}

function validateSchema<In>(def: TemplateDef<In>, input: unknown): In {
  if (!def.input || !('~standard' in def.input)) {
    return input as In;
  }
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

function validateOtpCode(kind: TemplateDef['kind'], input: unknown): void {
  if (kind !== 'otp') return;
  if (!input || typeof input !== 'object' || !('code' in input)) return;
  const code = (input as Record<string, unknown>).code;
  if (typeof code === 'string' && code.length < 4) {
    throw new TemplateValidationError('OTP code must be at least 4 characters');
  }
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
      template: {
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
