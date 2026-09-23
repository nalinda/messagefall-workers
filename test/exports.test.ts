/**
 * Export verification tests.
 *
 * These tests verify that the package.json#exports map is correct and that
 * each export target resolves to the built output.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'bun:test';

import { buildDist, reachableProviderFiles, walkImportGraph } from './helpers/bundle-isolation.js';

// These tests exercise what a consumer installs: the `package.json#exports`
// map and the dist files it points at, not the TypeScript sources. dist is
// rebuilt first so the assertions cannot pass against a stale artefact.
const rootDir = path.resolve(import.meta.dir, '..');

interface ExportTarget {
  types: string;
  import: string;
  default: string;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  exports: Record<string, ExportTarget>;
  files: string[];
  private?: boolean;
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as PackageJson;
}

function exportTarget(subpath: string): ExportTarget {
  const target = new Map(Object.entries(readPackageJson().exports)).get(subpath);
  if (!target) throw new Error(`package.json#exports has no "${subpath}" entry`);
  return target;
}

function distFile(relative: string): string {
  return path.join(rootDir, relative);
}

async function loadExport(subpath: string): Promise<Record<string, unknown>> {
  if (subpath.startsWith('./providers/')) {
    const providerName = subpath.replace('./providers/', '');
    const target = exportTarget('./providers/*');
    const resolvedPath = target.import.replace('*', () => providerName);
    return (await import(distFile(resolvedPath))) as Record<string, unknown>;
  }
  return (await import(distFile(exportTarget(subpath).import))) as Record<string, unknown>;
}

beforeAll(() => {
  buildDist();
});

describe('package.json#exports', () => {
  it('declares no runtime dependencies', () => {
    const pkg = readPackageJson();
    expect(pkg.dependencies).toBeUndefined();
  });

  it('marks package as private to prevent accidental npm publish', () => {
    const pkg = readPackageJson();
    expect(pkg.private).toBe(true);
  });

  it('publishes dist, and every export target is a file the build produces', () => {
    const pkg = readPackageJson();
    expect(pkg.files).toContain('dist');
    const sortedKeys = Object.keys(pkg.exports).toSorted((a, b) => a.localeCompare(b));
    expect(sortedKeys).toEqual(['.', './app', './client', './durable', './providers/*']);

    for (const [key, target] of Object.entries(pkg.exports)) {
      if (key === './providers/*') {
        const dts = target.types.replace('*', 'console');
        const esm = target.import.replace('*', 'console');
        expect(fs.existsSync(distFile(dts))).toBe(true);
        expect(fs.existsSync(distFile(esm))).toBe(true);
      } else {
        for (const file of [target.types, target.import, target.default]) {
          expect(file.startsWith('./dist/')).toBe(true);
          expect(fs.existsSync(distFile(file))).toBe(true);
        }
      }
      expect(target.default).toBe(target.import);
    }
  });

  it('ensures no file under src/ imports a schema library at runtime', () => {
    const schemaLibs = ['zod', 'valibot', 'arktype', 'yup', 'joi', 'myzod', 'superstruct'];
    function checkDir(dir: string): void {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          for (const lib of schemaLibs) {
            // Check for runtime import statements like: import ... from 'zod' or require('zod')
            // but ignore type-only imports like `import type ... from 'zod'`
            const runtimeImportRegex = new RegExp(
              String.raw`^\s*import\s+(?!type\s)(?:[^'"]*from\s+)?['"]${lib}(?:/.*)?['"]`,
              'm'
            );
            const requireRegex = new RegExp(String.raw`require\s*\(['"]${lib}(?:/.*)?['"]\)`, 'm');
            expect(runtimeImportRegex.test(content)).toBe(false);
            expect(requireRegex.test(content)).toBe(false);
          }
        }
      }
    }
    checkDir(path.join(rootDir, 'src'));
  });
});

describe('Entry points export documented functions', () => {
  it('exports createMessaging as a function from the built . entry point', async () => {
    const root = await loadExport('.');
    expect(typeof root.createMessaging).toBe('function');
  });

  // `hono` is an optional peer, so the ready-made app is its own entry point and the root
  // barrel must not pull it in: importing the root entry without `hono` installed has to work.
  it('exports createMessagingApp from the built ./app entry point and not from .', async () => {
    const app = await loadExport('./app');
    expect(typeof app.createMessagingApp).toBe('function');
    const root = await loadExport('.');
    expect(root.createMessagingApp).toBeUndefined();
  });

  it('keeps hono out of every entry point but ./app', () => {
    const pkg = readPackageJson();
    const providerTarget = exportTarget('./providers/*');
    const providerDirs = fs
      .readdirSync(distFile('./dist/providers'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => fs.existsSync(distFile(providerTarget.import.replace('*', () => name))));
    const roots = [
      ...Object.entries(pkg.exports)
        .filter(([key]) => key !== './providers/*' && key !== './app')
        .map(([, target]) => target.import),
      ...providerDirs.map((name) => providerTarget.import.replace('*', () => name)),
    ];
    const reachable = walkImportGraph(roots.map((relative) => distFile(relative)));
    for (const file of reachable) {
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/from\s*['"]hono['"]/);
    }
  });

  it('exports defineTemplates as a function', async () => {
    const root = await loadExport('.');
    expect(typeof root.defineTemplates).toBe('function');
  });

  // The root barrel used to `export *` its core modules, which published whatever they happened
  // to export — derivations and helpers the core shares between its own files — as 0.1.0 API
  // that could not then be changed without a major version. The barrel now lists each
  // sub-issue's documented interface explicitly; these two assertions keep it that way.
  it('keeps the core internals the modules share with each other off the root entry', async () => {
    const root = await loadExport('.');
    const internals = [
      'applyStatusEvents',
      'assertNoOtpWhatsAppText',
      'chainStatus',
      // Every provider ships behind its own `./providers/<name>` subpath; none is re-exported
      // from `src/providers/index.ts`, which the root entry pulls in for its types.
      'consoleProvider',
      // #10 scopes `createLogger` to `src/core/logger.ts`; the root entry's documented
      // interface (#1) is `createMessaging`, `createMessagingApp`, `defineTemplates` and types.
      'createLogger',
      'createWebhookHandler',
      'deriveOverallStatus',
      'extractTemplateSensitiveStrings',
      'isTerminalChainStatus',
      'renderValidated',
      'renderedContent',
      'resolveTimer',
      'scrubError',
      'validateInput',
      'validateTemplateDef',
    ];
    const exported = new Set(Object.keys(root));
    for (const name of internals) {
      expect(exported.has(name)).toBe(false);
    }
  });

  it('exports the whole documented public surface from the root entry', async () => {
    const root = await loadExport('.');
    const documented = [
      'CHANNELS',
      'DEFAULT_POLICY',
      'DEFAULT_STATUS_TTL',
      'E164',
      'EmailRecipientError',
      'EncryptionKeyError',
      'MessageRecordNotFoundError',
      'MessagingConfigError',
      'NoTemplateLanguageError',
      'OTP_ERROR_WITHHELD',
      'PolicyError',
      'ProviderConfigError',
      'RecipientError',
      'TemplateValidationError',
      'UnknownTemplateError',
      'advanceChain',
      'armTimer',
      'cancelTimer',
      'createMessaging',
      'definedChannels',
      'defineTemplates',
      'handleWebhook',
      'isEmailAddress',
      'kvStatusStore',
      'render',
      'resolveDelivery',
      'validateEnv',
    ];
    const exported = new Set(Object.keys(root));
    for (const name of documented) {
      expect(exported.has(name)).toBe(true);
    }
  });

  it('exports resolveDelivery, PolicyError, and DEFAULT_POLICY from the built . entry point', async () => {
    const root = await loadExport('.');
    expect(typeof root.resolveDelivery).toBe('function');
    expect(typeof root.PolicyError).toBe('function');
    expect(root.DEFAULT_POLICY).toEqual({ fallback: ['whatsapp', 'sms'], always: [] });
  });

  it('exports createMessagingClient as a function from the built ./client entry point', async () => {
    const client = await loadExport('./client');
    expect(typeof client.createMessagingClient).toBe('function');
  });

  it('exports FallbackTimer as a class from the built ./durable entry point', async () => {
    const durable = await loadExport('./durable');
    expect(typeof durable.FallbackTimer).toBe('function');
  });

  it('exports the console provider from the built ./providers/console entry point', async () => {
    const provider = await loadExport('./providers/console');
    expect(typeof provider.consoleProvider).toBe('function');
  });

  it('exports httpSms provider from the built ./providers/http-sms entry point', async () => {
    const provider = await loadExport('./providers/http-sms');
    expect(typeof provider.httpSms).toBe('function');
  });

  // Issue #4: meta-whatsapp is its own entry point and is absent from the
  // root bundle when unused.
  it('builds ./providers/meta-whatsapp as its own entry point (Issue #4)', () => {
    const target = exportTarget('./providers/*');
    const esm = target.import.replace('*', 'meta-whatsapp');
    const dts = target.types.replace('*', 'meta-whatsapp');
    expect(fs.existsSync(distFile(esm))).toBe(true);
    expect(fs.existsSync(distFile(dts))).toBe(true);
    for (const part of ['graph', 'webhook']) {
      expect(fs.existsSync(distFile(`./dist/providers/meta-whatsapp/${part}.js`))).toBe(true);
    }
  });

  it('exports metaWhatsApp as a function from the built ./providers/meta-whatsapp entry point (Issue #4)', async () => {
    const esm = exportTarget('./providers/*').import.replace('*', 'meta-whatsapp');
    expect(fs.existsSync(distFile(esm))).toBe(true);
    const provider = await loadExport('./providers/meta-whatsapp');
    expect(typeof provider.metaWhatsApp).toBe('function');
  });

  // Issue #4 asked this of meta-whatsapp, but it holds of every provider: `src/providers/index.ts`
  // is reachable from the root entry, so re-exporting any provider there would put it in the
  // bundle of every consumer that imports `createMessaging`. Enumerating the built provider
  // directories means a provider added later is covered without anyone remembering to add it.
  it('keeps every provider out of every bundle but its own (Issue #4)', () => {
    const providerTarget = exportTarget('./providers/*');
    const providerDirs = fs
      .readdirSync(distFile('./dist/providers'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // `_shared` holds helpers the providers deep-import; it has no index.js, so the
      // `./providers/*` wildcard does not resolve it and it is not an entry point.
      .filter((name) => fs.existsSync(distFile(providerTarget.import.replace('*', () => name))));

    expect(providerDirs).toContain('console');
    expect(providerDirs).toContain('meta-whatsapp');

    for (const name of providerDirs) {
      expect([name, reachableProviderFiles(name)]).toEqual([name, []]);
    }
  });

  it('does not publish ./providers/_shared as an entry point: it is internal to the providers', () => {
    const providerTarget = exportTarget('./providers/*');
    const shared = providerTarget.import.replace('*', () => '_shared');
    expect(fs.existsSync(distFile(shared))).toBe(false);
    expect(fs.existsSync(distFile('./dist/providers/_shared/http.js'))).toBe(true);
  });
});

describe('Node runtime package resolution', () => {
  it('resolves messagefall-workers, ./client, ./durable, ./providers/console, and ./providers/http-sms via package.json exports', () => {
    const script = `
      Promise.all([
        import('messagefall-workers'),
        import('messagefall-workers/client'),
        import('messagefall-workers/durable'),
        import('messagefall-workers/providers/console'),
        import('messagefall-workers/providers/http-sms'),
      ]).then(([root, client, durable, consoleMod, httpSmsMod]) => {
        if (typeof root.createMessaging !== 'function') process.exit(1);
        if (typeof client.createMessagingClient !== 'function') process.exit(2);
        if (typeof durable.FallbackTimer !== 'function') process.exit(3);
        if (typeof consoleMod.consoleProvider !== 'function') process.exit(4);
        if (typeof httpSmsMod.httpSms !== 'function') process.exit(5);
        process.exit(0);
      }).catch((err) => {
        console.error(err);
        process.exit(6);
      });
    `;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
  });
});

describe('CHANGELOG.md', () => {
  it('exists at the repo root and contains a 0.1.0 heading', () => {
    const changelogPath = path.join(rootDir, 'CHANGELOG.md');
    expect(fs.existsSync(changelogPath)).toBe(true);
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    expect(changelog).toMatch(/##\s+\[?0\.1\.0\]?/);
  });
});
