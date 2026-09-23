/**
 * Integration test harness for running examples/basic under wrangler dev.
 *
 * Starts the example Worker with real KV and Durable Object emulation,
 * providing typed send, status, webhook, record polling, and storage inspection.
 *
 * @module
 */

import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Database } from 'bun:sqlite';

import type { MessageRecord } from '../../src/core/status.js';
import { TEST_ENC_KEY } from '../helpers/messaging.js';

export interface HarnessOptions {
  port?: number;
  vars?: Record<string, string>;
  persistDir?: string;
  configPath?: string;
  entrypoint?: string;
}

/**
 * Ports are handed out from one randomly-seeded counter rather than drawn independently, so
 * several harnesses started in the same run cannot collide with each other — a `bind(): Address
 * already in use` from wrangler shows up as a flaky test with a baffling message.
 */
const portCounter = ((): { next: () => number } => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  let port = 8800 + (buf[0] % 1000);
  return {
    next: (): number => {
      port += 1;
      return port - 1;
    },
  };
})();

function getRandomPort(): number {
  return portCounter.next();
}

function hasRows(db: Database, table: string): boolean {
  const countRow = db.query(`SELECT COUNT(*) as count FROM "${table}"`).get() as {
    count: number;
  };
  return countRow.count > 0;
}

function isDatabaseEmpty(db: Database): boolean {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;

  return tables.every(({ name }) => !hasRows(db, name));
}

function isSqliteFileEmpty(fullPath: string): boolean {
  try {
    const db = new Database(fullPath, { readonly: true });
    try {
      return isDatabaseEmpty(db);
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

export class IntegrationHarness {
  static async start(options: HarnessOptions = {}): Promise<IntegrationHarness> {
    const port = options.port ?? getRandomPort();
    const persistDir =
      options.persistDir ?? path.join(os.tmpdir(), `mf-integration-${port}-${Date.now()}`);
    fs.mkdirSync(persistDir, { recursive: true });

    const rootDir = path.resolve(import.meta.dir, '../..');
    const entrypoint = options.entrypoint ?? path.join(rootDir, 'examples/basic/src/index.ts');
    const configPath = options.configPath ?? path.join(rootDir, 'examples/basic/wrangler.jsonc');

    const args = [
      'wrangler',
      'dev',
      '--local',
      '--port',
      String(port),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      persistDir,
      entrypoint,
      '--config',
      configPath,
    ];

    // Every fixture worker's catalogue has an otp template, which cannot run without a seal key.
    const vars = {
      MESSAGES_ENC_KEY: TEST_ENC_KEY,
      ...options.vars,
    };
    {
      for (const [key, value] of Object.entries(vars)) {
        args.push('--var', `${key}:${value}`);
      }
    }

    const proc = spawn('bunx', args, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for wrangler dev on port ${port}. Stdout: ${stdoutBuffer}\nStderr: ${stderrBuffer}`
          )
        );
      }, 15_000);

      const onData = (data: Buffer): void => {
        const text = data.toString();
        stdoutBuffer += text;
        if (text.includes('Ready on') || text.includes(`http://127.0.0.1:${port}`)) {
          cleanup();
          resolve();
        }
      };

      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };

      const onExit = (code: number | null): void => {
        cleanup();
        reject(
          new Error(
            `wrangler dev exited unexpectedly with code ${code}. Stdout: ${stdoutBuffer}\nStderr: ${stderrBuffer}`
          )
        );
      };

      function cleanup(): void {
        clearTimeout(timeout);
        proc.stdout.off('data', onData);
        proc.off('error', onError);
        proc.off('exit', onExit);
      }

      proc.stdout.on('data', onData);
      proc.stderr.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
      });
      proc.on('error', onError);
      proc.on('exit', onExit);
    });

    return new IntegrationHarness(port, persistDir, proc);
  }

  private readonly proc: ChildProcess;
  private isStopped = false;
  readonly baseUrl: string;
  readonly persistDir: string;
  readonly port: number;

  private constructor(port: number, persistDir: string, proc: ChildProcess) {
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.persistDir = persistDir;
    this.proc = proc;
  }

  async send(body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async status(id: string): Promise<Response> {
    return fetch(`${this.baseUrl}/status/${encodeURIComponent(id)}`);
  }

  async webhook(
    provider: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetch(`${this.baseUrl}/webhooks/${encodeURIComponent(provider)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  async waitForRecord(
    id: string,
    isSettled: (record: MessageRecord) => boolean,
    timeoutMs = 5000
  ): Promise<MessageRecord> {
    const deadline = Date.now() + timeoutMs;
    let lastRecord: MessageRecord | null = null;

    while (Date.now() < deadline) {
      const res = await this.status(id);
      if (res.ok) {
        const record = (await res.json()) as MessageRecord;
        lastRecord = record;
        if (isSettled(record)) {
          return record;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for record ${id} to settle. Last state: ${JSON.stringify(lastRecord)}`
    );
  }

  isTimerStorageEmpty(): boolean {
    const doDir = path.join(this.persistDir, 'v3/do');
    if (!fs.existsSync(doDir)) {
      return true;
    }
    const entries = fs.readdirSync(doDir, { recursive: true }) as string[];
    const sqliteFiles = entries.filter((f) => f.endsWith('.sqlite') && !f.includes('metadata'));

    for (const relPath of sqliteFiles) {
      const fullPath = path.join(doDir, relPath);
      if (!isSqliteFileEmpty(fullPath)) {
        return false;
      }
    }
    return true;
  }

  async stop(): Promise<void> {
    if (this.isStopped) return;
    this.isStopped = true;

    await new Promise<void>((resolve) => {
      this.proc.on('exit', () => resolve());
      this.proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          this.proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
    });

    try {
      fs.rmSync(this.persistDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
