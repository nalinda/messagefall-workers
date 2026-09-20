/**
 * Test helpers, type mirrors, and API loader for Issue #10 (No message bodies in logs, enforced in code).
 *
 * @module
 */

import type { Channel, DeliveryStatus } from '../../src/providers/types.js';

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
 * Arbitrary or free-form strings are prohibited.
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

/**
 * Logger API module interface.
 */
export interface LoggerApi {
  createLogger: (sink?: (line: string) => void) => Logger;
  scrubError?: (
    error: string,
    sensitive: Array<string | undefined | null> | { text?: string; subject?: string; params?: string[]; code?: string }
  ) => string;
}

/**
 * Type-level verification helpers.
 */
export type Extends<A, B> = A extends B ? true : false;
export type Not<T extends boolean> = T extends true ? false : true;
export type Expect<T extends true> = T;
export type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
  ? true
  : false;

/**
 * Type assertion helper for compile-time verification.
 */
export function assertType<T>(_value: T): void {
  // Compile-time type verification helper
}

/**
 * Dynamically loads the logger module from src/core/logger.js if implemented,
 * or returns a dummy stub in the RED phase so tests execute assertions
 * and fail on expectation assertions, not missing module imports.
 *
 * @returns LoggerApi implementation or no-op stub.
 */
export async function loadLoggerApi(): Promise<LoggerApi> {
  try {
    // The structured logger and the redaction engine are separate modules; the API under test
    // is the union of the two.
    const mod = (await import('../../src/core/logger.js')) as unknown as Partial<LoggerApi>;
    const redact = (await import('../../src/core/redact.js')) as unknown as Partial<LoggerApi>;
    if (mod.createLogger) {
      return { ...mod, ...redact } as LoggerApi;
    }
  } catch {
    // logger.js not yet implemented (RED phase)
  }

  try {
    const rootEntry = '../../src/index.js';
    const root = (await import(rootEntry)) as unknown as Partial<LoggerApi>;
    if (root.createLogger) {
      return root as LoggerApi;
    }
  } catch {
    // index.js does not export createLogger
  }

  return {
    createLogger: (_sink?: (line: string) => void): Logger => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    scrubError: (err: string) => err,
  };
}
