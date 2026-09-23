/**
 * The header a Worker-to-Worker send carries its shared secret in.
 *
 * The Hono app checks it and the client sets it, so both import it from here rather than each
 * spelling it out. Like `./base-path.js`, it is dependency-free so the client entry point stays
 * free of the rest of the core and of the optional `hono` peer.
 *
 * @module
 */

/**
 * The request header `/send` and `/status/:id` read the shared secret from.
 */
export const SECRET_HEADER = 'x-messagefall-secret';
