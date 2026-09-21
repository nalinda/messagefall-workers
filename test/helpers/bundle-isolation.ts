/**
 * Shared bundle-isolation helpers: walks the built ESM import graph to prove a provider unused
 * by a configuration is genuinely unreachable from any other entry point, not just absent from
 * the root barrel's own source.
 *
 * This is the same pattern `test/exports.test.ts` uses for meta-whatsapp (Issue #4). Extracted so
 * `test/providers/gmail.test.ts` and `test/providers/http-sms.test.ts` prove the same thing for
 * their own provider, rather than each restating (or, previously, silently skipping) the check.
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const rootDir = path.resolve(import.meta.dir, '../..');

// `from './x.js'` (static import/export), `import('./x.js')` (dynamic) and
// `import './x.js'` (bare side-effect import).
const STATIC_SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_SPECIFIER = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const BARE_SPECIFIER = /\bimport\s+['"]([^'"]+)['"]/g;

/**
 * Absolute paths of the relative modules `file` imports.
 */
function relativeImportsOf(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = [
    ...source.matchAll(STATIC_SPECIFIER),
    ...source.matchAll(DYNAMIC_SPECIFIER),
    ...source.matchAll(BARE_SPECIFIER),
  ].map((match) => match[1]);
  return specifiers
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => path.resolve(path.dirname(file), specifier));
}

/**
 * Walks the ESM import graph from the given absolute files, following only relative specifiers,
 * and returns every file reached (including the roots).
 *
 * Throws when a reached file is missing rather than skipping it, so a stale or unbuilt `dist`
 * fails loudly instead of letting a caller's isolation check silently pass with nothing asserted.
 */
export function walkImportGraph(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`import graph reached a missing file: ${file}`);
    seen.add(file);
    queue.push(...relativeImportsOf(file));
  }
  return seen;
}

interface PackageJson {
  exports: Record<string, { import: string }>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as PackageJson;
}

/**
 * Rebuilds `dist` so the isolation check below cannot pass against a stale or absent build
 * artefact — bun gives no cross-file ordering guarantee, so nothing else can be relied on to
 * have built it first.
 */
export function buildDist(): void {
  const result = spawnSync('bun', ['run', 'build'], { cwd: rootDir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`bun run build failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/**
 * The built files, reachable from every entry point other than `providerName`'s own, that
 * actually live under that provider's `dist/providers/<providerName>/` directory.
 *
 * An empty result proves the provider cannot be reached — and so cannot land in a consumer's
 * bundle — except through its own dedicated `./providers/<providerName>` entry point.
 *
 * @param providerName - The provider's directory name under `src/providers` / `dist/providers`.
 */
export function reachableProviderFiles(providerName: string): string[] {
  const pkg = readPackageJson();
  const providerTarget = pkg.exports['./providers/*'];
  const providerDirs = fs
    .readdirSync(path.join(rootDir, 'dist/providers'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== providerName)
    .map((entry) => entry.name)
    // `_shared` holds helpers the providers deep-import; it has no index.js, so the
    // `./providers/*` wildcard does not resolve it and it is not an entry point.
    .filter((name) =>
      fs.existsSync(
        path.join(
          rootDir,
          providerTarget.import.replace('*', () => name)
        )
      )
    );

  const roots = [
    ...Object.entries(pkg.exports)
      .filter(([key]) => key !== './providers/*')
      .map(([, target]) => target.import),
    ...providerDirs.map((name) => providerTarget.import.replace('*', () => name)),
  ];

  const reachable = walkImportGraph(roots.map((relative) => path.join(rootDir, relative)));
  return [...reachable].filter((file) =>
    file.includes(path.join('providers', providerName) + path.sep)
  );
}
