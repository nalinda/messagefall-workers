/**
 * Structural logger and zero-content leakage enforcement.
 *
 * All structured log lines pass through this logger, which enforces allow-listed event names
 * and typed identifier/telemetry fields. Sensitive message content (bodies, codes, subjects,
 * params) is structurally prohibited on log fields and scrubbed from vendor error strings.
 *
 * @module
 */

import type { Channel, DeliveryStatus } from '../providers/types.js';

/**
 * Identifier and telemetry fields allowed on structured log lines.
 * Free-form or message content fields (such as text, body, code, subject, params, input) are prohibited.
 */
export interface LogFields {
  id?: string;
  template?: string;
  kind?: 'otp' | 'notification';
  channel?: Channel;
  provider?: string;
  providerId?: string;
  status?: DeliveryStatus | 'pending';
  errorCode?: string;
  count?: number;
}

/**
 * Allow-listed log event names.
 * Arbitrary or free-form strings are prohibited at compile time.
 */
export type LogEvent =
  | 'send.start'
  | 'send.attempt'
  | 'send.retry'
  | 'send.channel-skipped'
  | 'webhook.applied'
  | 'webhook.received'
  | 'fallback.advance'
  | 'timer.armed'
  | 'timer.cancelled';

/**
 * Supported log levels.
 */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Structural logger interface accepting only allow-listed event names and LogFields.
 */
export interface Logger {
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
}

function writeConsole(level: LogLevel, line: string): void {
  switch (level) {
    case 'error': {
      console.error(line);
      break;
    }
    case 'warn': {
      console.warn(line);
      break;
    }
    case 'info': {
      console.log(line);
      break;
    }
  }
}

/**
 * Creates a structural logger instance that writes formatted JSON lines to the provided sink.
 * Defaults to JSON written to console (`console.error`, `console.warn`, `console.log`).
 *
 * @param sink - Custom log output sink callback.
 * @returns Logger instance.
 */
export function createLogger(sink?: (line: string) => void): Logger {
  const log = (level: LogLevel, event: LogEvent, fields?: LogFields): void => {
    const record = {
      level,
      event,
      ...fields,
    };
    const json = JSON.stringify(record);
    if (sink) {
      sink(json);
    } else {
      writeConsole(level, json);
    }
  };

  return {
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

function collectFromString(data: string, out: Set<string>): void {
  const trimmed = data.trim();
  if (trimmed.length > 0) {
    out.add(data);
    if (trimmed !== data) {
      out.add(trimmed);
    }
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
  if (typeof data === 'number' || typeof data === 'boolean') {
    out.add(String(data));
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

  const prefix = patternStr.slice(0, markerIdx);
  const suffix = patternStr.slice(markerEnd + PARAM_SUFFIX.length);

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

function getTemplateDefinition(
  templates: unknown,
  templateName: string
): Record<string, unknown> | undefined {
  if (templates instanceof Map) {
    return templates.get(templateName) as Record<string, unknown> | undefined;
  }
  if (templates && typeof templates === 'object') {
    for (const [key, value] of Object.entries(templates)) {
      if (key === templateName && value && typeof value === 'object') {
        return value as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

/**
 * Extracts sensitive strings and parameter values from template definitions given an error message.
 *
 * @param templates - Template catalog or definitions map.
 * @param templateName - Name of the template.
 * @param error - Raw vendor error string.
 * @returns Array of extracted sensitive substrings.
 */
export function extractTemplateSensitiveStrings(
  templates: unknown,
  templateName: string,
  error: string
): string[] {
  if (!templates || !templateName || !error) return [];
  const templateDef = getTemplateDefinition(templates, templateName);
  if (!templateDef) return [];

  const sensitive: string[] = [];
  const proxy = new Proxy(
    {},
    {
      get: (_, prop) => `${PARAM_PREFIX}${String(prop)}${PARAM_SUFFIX}`,
    }
  );

  const templateObj = templateDef as {
    sms?: unknown;
    whatsapp?: unknown;
    email?: unknown;
  };
  const channelFns = [templateObj.sms, templateObj.whatsapp, templateObj.email];

  for (const fn of channelFns) {
    if (typeof fn !== 'function') continue;
    try {
      const rendered = (fn as (input: unknown) => unknown)(proxy);
      const stringsToTest = extractRenderedStrings(rendered);
      for (const patternStr of stringsToTest) {
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
