/**
 * messagefall-workers - Providers
 *
 * Types only. Every provider implementation ships behind its own `./providers/<name>` subpath
 * export, which is what keeps it out of the bundle of a consumer that does not use it — #4 makes
 * that an explicit criterion for meta-whatsapp, and the console provider is no different: this
 * barrel is reachable from the root entry, so anything re-exported here lands in the bundle of
 * every `import { createMessaging } from 'messagefall-workers'`.
 *
 * @module
 */

export * from './types.js';
