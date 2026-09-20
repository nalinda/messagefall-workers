/**
 * `messagefall-workers/durable`: the FallbackTimer Durable Object for timed fallback.
 *
 * Export the class from the same Worker module that calls `createMessagingApp` and bind it as
 * `FALLBACK_TIMER` (see the README's quick start for the wrangler configuration).
 *
 * @module
 */

export { FallbackTimer } from './fallback-timer.js';
