/**
 * Redaction engine: keeps message content out of anything that gets persisted or logged.
 *
 * Vendor error strings routinely echo back the body they rejected, so every error that reaches
 * a status record or a log line is first run through {@link scrubError} with the values that
 * produced it. {@link extractTemplateSensitiveStrings} recovers the rendered strings for a
 * template when only the template name is known (the webhook path), by rendering it with a
 * marker proxy and matching the resulting pattern against the error.
 *
 * @module
 */

import { getTemplate, type TemplateDef, type Templates } from '../templates.js';

/**
 * The shortest value worth redacting, in characters.
 *
 * A value in the input is redaction-worthy when it could be the message content itself — a
 * numeric OTP, say. Short ones cannot be: they are `{ retries: 4 }`, `{ attempt: 2 }`,
 * `{ initial: 'a' }` or `{ locale: 'si' }`, and collecting them shreds ordinary vendor error
 * text that happens to contain the same characters, turning "400 Bad Request" into
 * "[redacted]00 Bad Request" and "Invalid sender" into "Inv[redacted]lid sender". Four
 * characters is the shortest OTP anyone issues, so that is the floor.
 *
 * It applies to strings and numbers alike: a one-character string is exactly the hazard the
 * numeric floor exists to prevent, so the two must not disagree.
 */
const MIN_SENSITIVE_LENGTH = 4;

function collectFromString(data: string, out: Set<string>): void {
  const trimmed = data.trim();
  if (trimmed.length >= MIN_SENSITIVE_LENGTH) {
    out.add(data);
    if (trimmed !== data) {
      out.add(trimmed);
    }
  }
}

function collectFromNumber(data: number, out: Set<string>): void {
  const asString = String(data);
  if (asString.length >= MIN_SENSITIVE_LENGTH) {
    out.add(asString);
  }
}

function collectFromObject(data: object, out: Set<string>): void {
  if (Array.isArray(data)) {
    for (const item of data) {
      collectSensitiveStrings(item, out);
    }
  } else {
    for (const val of Object.values(data)) {
      collectSensitiveStrings(val, out);
    }
  }
}

function collectSensitiveStrings(data: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (data === null || data === undefined) {
    return out;
  }
  if (typeof data === 'string') {
    collectFromString(data, out);
    return out;
  }
  if (typeof data === 'number') {
    collectFromNumber(data, out);
    return out;
  }
  // A boolean is never the leaked content, but `true` / `false` occur in ordinary vendor error
  // text, so collecting one only damages the error.
  if (typeof data === 'boolean') {
    return out;
  }
  if (typeof data === 'object') {
    collectFromObject(data, out);
  }
  return out;
}

const PARAM_PREFIX = '__MF_PARAM_';
const PARAM_SUFFIX = '__';

function extractFromTemplateString(patternStr: string, error: string, sensitive: string[]): void {
  const markerIdx = patternStr.indexOf(PARAM_PREFIX);
  if (markerIdx === -1) {
    if (error.includes(patternStr)) {
      sensitive.push(patternStr);
    }
    return;
  }

  const markerEnd = patternStr.indexOf(PARAM_SUFFIX, markerIdx + PARAM_PREFIX.length);
  if (markerEnd === -1) {
    return;
  }

  pushBoundedMatch(
    patternStr.slice(0, markerIdx),
    patternStr.slice(markerEnd + PARAM_SUFFIX.length),
    error,
    sensitive
  );
}

/**
 * Recovers the substituted value from `error` by locating the literal text the template rendered
 * around it, and records both that value and the whole rendered span.
 */
function pushBoundedMatch(
  prefix: string,
  suffix: string,
  error: string,
  sensitive: string[]
): void {
  // A pattern that is nothing but the marker (a WhatsApp `params` entry rendering a bare value,
  // for instance) gives no literal text to anchor on, so any match would span the whole error
  // string and redact it entirely. Without bounds the value cannot be recovered; skip it rather
  // than destroy the error.
  //
  // Worth naming the consequence: this path is the fallback the webhook takes once `in:<id>` has
  // expired (chain timeout, floor 60s) while the status record is still alive (7 days). So for a
  // template whose only OTP parameter renders bare — `params: (i) => [i.code]`, as the README
  // shows — a late vendor error quoting the code back is persisted unscrubbed on a record
  // `GET /status/:id` serves. Neither escape is free: anchoring on a neighbouring parameter still
  // needs literal text that a bare-value list does not have, and extending `in:<id>` to the
  // record's TTL would keep the code in plaintext for seven days to close a gap that opens after
  // one minute. Recorded in CHANGELOG's "Known limitations" instead.
  if (prefix.length === 0 && suffix.length === 0) {
    return;
  }

  const startIdx = error.indexOf(prefix);
  if (startIdx === -1) {
    return;
  }

  const paramStart = startIdx + prefix.length;
  const endIdx = suffix.length > 0 ? error.indexOf(suffix, paramStart) : error.length;
  if (endIdx === -1) {
    return;
  }

  const full = error.slice(startIdx, endIdx + suffix.length);
  const param = error.slice(paramStart, endIdx);
  if (full.length > 0) sensitive.push(full);
  if (param.length > 0) sensitive.push(param);
}

function extractRenderedStrings(rendered: unknown): string[] {
  if (typeof rendered === 'string') {
    return [rendered];
  }
  if (rendered && typeof rendered === 'object') {
    const r = rendered as { text?: unknown; subject?: unknown; html?: unknown };
    const strings: string[] = [];
    if (typeof r.text === 'string') strings.push(r.text);
    if (typeof r.subject === 'string') strings.push(r.subject);
    if (typeof r.html === 'string') strings.push(r.html);
    return strings;
  }
  return [];
}

/**
 * The genuinely sensitive parts of a rendered outbound payload: the message content, and
 * nothing else.
 *
 * The payload handed to a provider is the rendered message merged over an `OutboundMeta` —
 * `to`, `messageId`, `template`, `kind`, `locale`. Feeding the whole thing to {@link scrubError}
 * shreds ordinary vendor error messages, because those metadata values are short and share
 * substrings with real words: with `to: '+9477…'` harmless, but `kind: 'otp'` or a template
 * named `to` turns "Token expired" into "T[redacted]n expired". Only the content can actually
 * leak the message, so only the content is scrubbed for.
 *
 * @param payload - The rendered payload sent to a provider.
 * @returns The content values to scrub the vendor's error against.
 */
export function renderedContent(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const content: unknown[] = extractRenderedStrings(payload);
  const { templateConfig } = payload as { templateConfig?: { params?: unknown } };
  // RenderedWhatsApp's Meta template config carries the substituted parameters. `template`
  // beside it is only the catalogue name, which is metadata and deliberately not scrubbed for.
  if (templateConfig && typeof templateConfig === 'object' && 'params' in templateConfig) {
    content.push(templateConfig.params);
  }
  return content;
}

type RenderFn = (input: unknown) => unknown;

/**
 * Every function a template definition can render content with.
 *
 * `sms` is a function on the definition itself, but `whatsapp` is a `WhatsAppTemplateConfig` and
 * `email` an `EmailTemplateConfig` — objects whose own members (`params`/`text`, and
 * `subject`/`text`/`html`) do the rendering. Probing only the top-level function-valued channels
 * would leave the marker-proxy recovery dead for two of the three channels.
 */
function collectRenderFunctions(templateDef: TemplateDef<unknown>): RenderFn[] {
  const { sms, whatsapp, email } = templateDef as {
    sms?: unknown;
    whatsapp?: unknown;
    email?: unknown;
  };
  return [sms, whatsapp, email].flatMap((channel) => channelRenderFunctions(channel));
}

/**
 * The render functions of one channel entry: the entry itself when it is a function (`sms`), or
 * its function-valued members when it is a config object (`whatsapp`, `email`).
 */
function channelRenderFunctions(channel: unknown): RenderFn[] {
  if (typeof channel === 'function') {
    return [channel as RenderFn];
  }
  if (channel && typeof channel === 'object') {
    return Object.values(channel).filter(
      (member): member is RenderFn => typeof member === 'function'
    );
  }
  return [];
}

/**
 * The marker-bearing strings a render function produced: a rendered body, the members of a
 * rendered email object, or the entries of a WhatsApp `params` array.
 */
function renderedPatternStrings(rendered: unknown): string[] {
  if (Array.isArray(rendered)) {
    return rendered.filter((item): item is string => typeof item === 'string');
  }
  return extractRenderedStrings(rendered);
}

/**
 * Extracts sensitive strings and parameter values from template definitions given an error message.
 *
 * @param templates - Template catalog.
 * @param templateName - Name of the template.
 * @param error - Raw vendor error string.
 * @returns Array of extracted sensitive substrings.
 */
export function extractTemplateSensitiveStrings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  templates: Templates<any> | undefined,
  templateName: string,
  error: string
): string[] {
  if (!templates || !templateName || !error) return [];
  const templateDef = getTemplate(templates, templateName);
  if (!templateDef) return [];

  const sensitive: string[] = [];
  const proxy = new Proxy(
    {},
    {
      get: (_, prop) => `${PARAM_PREFIX}${String(prop)}${PARAM_SUFFIX}`,
    }
  );

  for (const fn of collectRenderFunctions(templateDef)) {
    try {
      const rendered = fn(proxy);
      for (const patternStr of renderedPatternStrings(rendered)) {
        extractFromTemplateString(patternStr, error, sensitive);
      }
    } catch {
      // Ignore template evaluation error
    }
  }

  return sensitive;
}

/**
 * Scrubs vendor error strings by removing any substring equal to rendered text,
 * subject, parameters, or input before storing on status records.
 *
 * @param error - Raw error string from provider or exception.
 * @param sensitive - Sensitive data, array of sensitive values, or object containing sensitive fields.
 * @returns Sanitized error string with sensitive substrings redacted.
 */
export function scrubError(error: string, sensitive?: unknown): string {
  if (!error || typeof error !== 'string') {
    return error;
  }
  if (!sensitive) {
    return error;
  }

  const sensitiveStrings = [...collectSensitiveStrings(sensitive)]
    .filter((s) => s.length > 0)
    .toSorted((a, b) => b.length - a.length);

  let result = error;
  for (const s of sensitiveStrings) {
    result = result.replaceAll(s, '[redacted]');
    try {
      const jsonEncoded = JSON.stringify(s).slice(1, -1);
      if (jsonEncoded !== s && jsonEncoded.length > 0) {
        result = result.replaceAll(jsonEncoded, '[redacted]');
      }
    } catch {
      // ignore
    }
  }
  return result;
}
