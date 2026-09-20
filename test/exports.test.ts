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
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`bun run build failed:\n${result.stdout}\n${result.stderr}`);
  }
});

describe('package.json#exports', () => {
  it('declares no runtime dependencies', () => {
    const pkg = readPackageJson();
    expect(pkg.dependencies).toBeUndefined();
  });

  it('publishes dist, and every export target is a file the build produces', () => {
    const pkg = readPackageJson();
    expect(pkg.files).toContain('dist');
    const sortedKeys = Object.keys(pkg.exports).toSorted((a, b) => a.localeCompare(b));
    expect(sortedKeys).toEqual(['.', './client', './durable', './providers/*']);

    for (const [key, target] of Object.entries(pkg.exports)) {
      if (key === './providers/*') {
        const dts = target.types.replace('*', 'stub');
        const esm = target.import.replace('*', 'stub');
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
              'm',
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

  it('exports createMessagingApp as a function from the built . entry point', async () => {
    const root = await loadExport('.');
    expect(typeof root.createMessagingApp).toBe('function');
  });

  it('exports defineTemplates as a function', async () => {
    const root = await loadExport('.');
    expect(typeof root.defineTemplates).toBe('function');
  });

  it('exports route as a function', async () => {
    const root = await loadExport('.');
    expect(typeof root.route).toBe('function');
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

  it('exports stub provider from the built ./providers/stub entry point', async () => {
    const provider = await loadExport('./providers/stub');
    expect(typeof provider.StubProvider).toBe('function');
  });

  it('exports httpSms provider from the built ./providers/http-sms entry point', async () => {
    const provider = await loadExport('./providers/http-sms');
    expect(typeof provider.httpSms).toBe('function');
  });
});

describe('Node runtime package resolution', () => {
  it('resolves messagefall-workers, ./client, ./durable, ./providers/stub, and ./providers/http-sms via package.json exports', () => {
    const script = `
      Promise.all([
        import('messagefall-workers'),
        import('messagefall-workers/client'),
        import('messagefall-workers/durable'),
        import('messagefall-workers/providers/stub'),
        import('messagefall-workers/providers/http-sms'),
      ]).then(([root, client, durable, stub, httpSmsMod]) => {
        if (typeof root.createMessaging !== 'function') process.exit(1);
        if (typeof client.createMessagingClient !== 'function') process.exit(2);
        if (typeof durable.FallbackTimer !== 'function') process.exit(3);
        if (typeof stub.StubProvider !== 'function') process.exit(4);
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
