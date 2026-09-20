/**
 * Export verification tests.
 *
 * These tests verify that the package.json#exports map is correct and that
 * each export target resolves to the built output.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, beforeAll } from 'bun:test';

const rootDir = path.resolve(import.meta.dir, '..');

interface ExportTarget {
  types: string;
  import: string;
  default: string;
}

function readPackageJson(): Record<string, ExportTarget> {
  const content = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8');
  return JSON.parse(content).exports;
}

function distFile(relative: string): string {
  return path.join(rootDir, relative);
}

async function loadExport(subpath: string): Promise<Record<string, unknown>> {
  const target = readPackageJson()[subpath];
  if (!target) {
    throw new Error(`No export target for "${subpath}"`);
  }
  return (await import(distFile(target.import))) as Record<string, unknown>;
}

beforeAll(() => {
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(`Build failed:\n${result.stderr}`);
  }
});

describe('Exports map', () => {
  it('has correct export entries', () => {
    const pkg = readPackageJson();
    expect(pkg['.']).toBeDefined();
    expect(pkg['./client']).toBeDefined();
    expect(pkg['./durable']).toBeDefined();
    expect(pkg['./providers/stub']).toBeDefined();
  });
});

describe('Root entry point', () => {
  it('exports createMessaging as a function', async () => {
    const root = await loadExport('.');
    expect(typeof root.createMessaging).toBe('function');
  });

  it('exports createMessagingApp as a function', async () => {
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
});

describe('Client entry point', () => {
  it('exports createMessagingClient as a function', async () => {
    const client = await loadExport('./client');
    expect(typeof client.createMessagingClient).toBe('function');
  });
});

describe('Durable entry point', () => {
  it('exports FallbackTimer', async () => {
    const durable = await loadExport('./durable');
    expect(durable.FallbackTimer).toBeDefined();
  });
});

describe('Stub provider', () => {
  it('exports stubFactory as an object', async () => {
    const stub = await import(distFile('providers/stub/index.js'));
    expect(stub.stubFactory).toBeDefined();
    expect(typeof stub.stubFactory).toBe('object');
  });
});
