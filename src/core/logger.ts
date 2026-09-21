/**
 * Structural logger.
 *
 * All structured log lines pass through this logger, which enforces allow-listed event names
 * and typed identifier/telemetry fields. Sensitive message content (bodies, codes, subjects,
 * params) is structurally prohibited on log fields.
 *
 * Scrubbing that content out of vendor error strings before they are persisted is a separate
 * concern and lives in `./redact.js`.
 *
 * @module
 */

import type { Channel, DeliveryStatus, TemplateKind } from '../providers/types.js';

/**
 * Identifier and telemetry fields allowed on structured log lines.
 * Free-form or message content fields (such as text, body, code, subject, params, input) are prohibited.
 */
export interface LogFields {
  id?: string;
  template?: string;
  kind?: TemplateKind;
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
  | 'send.persist-failed'
  | 'send.observer-failed'
  | 'send.index-failed'
  | 'send.retry'
  | 'send.channel-skipped'
  | 'webhook.applied'
  | 'webhook.received'
  | 'webhook.event-failed'
  | 'fallback.advance'
  | 'fallback.advance-skipped'
  | 'fallback.input-lost'
  | 'timer.armed'
  | 'timer.arm-failed'
  | 'timer.cancelled'
  | 'timer.gave-up'
  | 'timer.off'
  | 'timer.options-replaced'
  | 'timer.unconfigured';

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
