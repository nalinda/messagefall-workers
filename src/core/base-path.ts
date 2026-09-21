/**
 * The base path both ends of a Worker-to-Worker send agree on.
 *
 * The Hono app mounts its routes under it and the client addresses them under it, so the two
 * must normalise it identically by construction — hence one implementation rather than a copy on
 * each side. Nothing else lives here: the client entry point stays free of the rest of the core.
 *
 * @module
 */

/**
 * Normalises a configured base path to either `''` or a single leading slash with no trailing
 * one, so `'/api/v1'`, `'api/v1'` and `'/api/v1/'` all address the same routes.
 *
 * @param basePath - The base path as configured, if any.
 * @returns The normalised prefix, empty for the root.
 */
export function normalizeBasePath(basePath?: string): string {
  if (!basePath) return '';
  const trimmed = basePath.trim();
  const withoutLeading = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  const withoutTrailing = withoutLeading.endsWith('/')
    ? withoutLeading.slice(0, -1)
    : withoutLeading;
  return withoutTrailing ? `/${withoutTrailing}` : '';
}
