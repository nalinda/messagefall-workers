/**
 * Export verification tests.
 *
 * These tests verify that the package.json#exports map is correct and that
 * each export target resolves to the built output.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

import type { CreateMessagingMagicLinkOptions, CreateMessagingPhoneOptions } from '../src/index';

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
  exports: Record<string, ExportTarget>;
  files: string[];
}

function readPackageJson(): PackageJson {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed repo path
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
  it('publishes dist, and every export target is a file the build produces', () => {
    const pkg = readPackageJson();
    expect(pkg.files).toContain('dist');
    const sortedKeys = Object.keys(pkg.exports).sort((a, b) => a.localeCompare(b));
    expect(sortedKeys).toEqual(['.', './client', './durable', './providers/*']);
    for (const target of Object.values(pkg.exports)) {
      for (const file of [target.types, target.import, target.default]) {
        expect(file.startsWith('./dist/')).toBe(true);
        expect(fs.existsSync(distFile(file))).toBe(true);
      }
      expect(target.default).toBe(target.import);
    }
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

  it('exports createMessagingClient as a function from the built ./client entry point', async () => {
    const client = await loadExport('./client');
    expect(typeof client.createMessagingClient).toBe('function');
  });
});
