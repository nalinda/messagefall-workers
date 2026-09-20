/**
 * Test helpers and type mirrors for template catalog specifications (Issue #2).
 *
 * @module
 */

import type { DeliveryOverride } from '../../src/core/policy.js';
import type {
  Channel,
  RenderedEmail,
  RenderedSms,
  RenderedWhatsApp,
} from '../../src/providers/types.js';
import type { StandardSchemaV1 } from '../../src/types.js';

export type AnyRendered = RenderedWhatsApp | RenderedSms | RenderedEmail;

/**
 * WhatsApp template configuration options.
 */
export type WhatsAppTemplateConfig<In> =
  | {
      template: string;
      language: string | Record<string, string>;
      params: (input: In, locale: string) => string[];
      text?: never;
    }
  | {
      text: (input: In, locale: string) => string;
      template?: never;
      language?: never;
      params?: never;
    };

/**
 * Email template configuration options.
 */
export interface EmailTemplateConfig<In> {
  subject: (input: In, locale: string) => string;
  text: (input: In, locale: string) => string;
  html?: (input: In, locale: string) => string;
}

/**
 * Template definition for a typed template catalog.
 */
export interface TemplateDef<In = unknown> {
  input: StandardSchemaV1<unknown, In>;
  kind: 'otp' | 'notification';
  whatsapp?: WhatsAppTemplateConfig<In>;
  sms?: (input: In, locale: string) => string;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Templates<T extends Record<string, TemplateDef<any>> = Record<string, TemplateDef<any>>> = {
  readonly [K in keyof T]: T[K];
};

/**
 * Templates API interface contract.
 */
export interface TemplatesApi {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineTemplates: <T extends Record<string, TemplateDef<any>>>(defs: T) => Templates<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definedChannels: (def: TemplateDef<any>) => Channel[];
  render: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    def: TemplateDef<any>,
    channel: Channel,
    input: unknown,
    locale: string,
  ) => AnyRendered;
}

/**
 * Loads the templates module from src/templates.js if implemented, or falls back to
 * src/index.js stubs so tests execute real assertions and fail for the right reason.
 */
export async function loadTemplatesApi(): Promise<TemplatesApi> {
  try {
    const templatesEntry = '../../src/templates.js';
    const mod = (await import(templatesEntry)) as unknown as Partial<TemplatesApi>;
    if (mod.defineTemplates && mod.definedChannels && mod.render) {
      return mod as TemplatesApi;
    }
  } catch {
    // templates.js not yet implemented
  }

  const root = (await import('../../src/index.js')) as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defineTemplates?: <T extends Record<string, TemplateDef<any>>>(defs: T) => Templates<T>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    definedChannels?: (def: TemplateDef<any>) => Channel[];
    render?: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      def: TemplateDef<any>,
      channel: Channel,
      input: unknown,
      locale: string,
    ) => AnyRendered;
  };

  return {
    defineTemplates: (root.defineTemplates ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((defs: Record<string, TemplateDef<any>>) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        defs as unknown as Templates<Record<string, TemplateDef<any>>>)) as TemplatesApi['defineTemplates'],
    definedChannels: (root.definedChannels ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((_def: TemplateDef<any>) => [])),
    render: (root.render ??
      ((
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _def: TemplateDef<any>,
        _channel: Channel,
        _input: unknown,
        _locale: string,
      ): AnyRendered => {
        return undefined as unknown as RenderedWhatsApp;
      })),
  };
}
