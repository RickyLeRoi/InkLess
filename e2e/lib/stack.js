// e2e/lib/stack.js

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const ADMIN_USER = 'e2e-admin';
const ADMIN_PASSWORD = 'e2e-password';
const HARDWARE_TOKEN = 'e2e-hardware-token';

/** @returns {Promise<number>} */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} probe
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function waitUntil(label, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resume) => setTimeout(resume, 100));
  }

  throw new Error(`timed out waiting for ${label}${lastError ? ` (last error: ${lastError})` : ''}`);
}

/**
 * The two real processes, on a real port, talking over a real socket.
 *
 * Everything the daemon would touch on the Pi — spool, clips, overlay — is redirected
 * into a throwaway directory, and both adapters stay fake. What is genuinely exercised
 * is the wiring: SSE, the catch-up fetch, the callbacks and the SQLite file.
 */
export class Stack {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'inkless-e2e-'));
    this.spoolPath = join(this.dir, 'spool.txt');
    this.port = 0;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.backend = null;
    /** @type {import('node:child_process').ChildProcess | null} */
    this.daemon = null;
    /** Kept so a failure can show what the two processes actually said. */
    this.transcript = /** @type {string[]} */ ([]);
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    // 20260831 ++ RG #node_version_guard
    // The backend imports node:sqlite, which does not exist before 22.5. Without this
    // the whole suite dies on a 30-second health-check timeout that says nothing about
    // the actual cause, which is a forgotten `nvm use`.
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      throw new Error(
        `these tests spawn the backend with the node running them (${process.versions.node}), ` +
          'and it needs >= 22.5 for node:sqlite. Run `nvm use` first.'
      );
    }

    this.port = await freePort();

    this.backend = this.#spawn('backend', process.execPath, ['src/index.js'], join(ROOT, 'backend'), {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(this.port),
      DATABASE_PATH: join(this.dir, 'inkless.db'),
      PUBLIC_BASE_URL: 'http://127.0.0.1:5173',
      ADMIN_USER,
      ADMIN_PASSWORD,
      HARDWARE_TOKEN,
      PAYMENT_PROVIDER: 'fake',
      MODERATION_LLM_PROVIDER: 'none',
      // The point here is the flow, not the throttle, which api.test.js already covers.
      RATE_LIMIT_SUBMISSIONS_PER_HOUR: '500',
      RATE_LIMIT_PRINTS_PER_HOUR: '500'
    });

    await this.#waitOrExplain('the backend to answer /health', async () =>
      (await this.health()).status === 'ok'
    );
    await this.startDaemon();
  }

  async startDaemon() {
    this.daemon = this.#spawn('daemon', 'python3', ['-m', 'inkless'], join(ROOT, 'hardware'), {
      PYTHONPATH: 'src',
      PYTHONUNBUFFERED: '1',
      BACKEND_URL: this.baseUrl,
      HARDWARE_TOKEN,
      PRINTER_KIND: 'fake',
      RECORDER_KIND: 'fake',
      UPLOADER_KIND: 'local',
      PRINTER_SPOOL_PATH: this.spoolPath,
      CLIPS_DIRECTORY: join(this.dir, 'clips'),
      LOCAL_CLIPS_DIRECTORY: join(this.dir, 'public'),
      OVERLAY_PATH: join(this.dir, 'overlay.txt'),
      PUBLIC_CLIPS_URL: 'http://127.0.0.1:8080/clips',
      RECONNECT_SECONDS: '1'
    });

    await this.#waitOrExplain(
      'the hardware node to appear on /health',
      async () => (await this.health()).hardwareOnline === true
    );
  }

  /**
   * Defaults to SIGKILL, which is the situation the catch-up path exists for: the node
   * loses power mid-queue and nobody gets to run a shutdown handler. Pass 'SIGTERM' to
   * exercise the orderly path instead.
   *
   * @param {NodeJS.Signals} [signal]
   * @returns {Promise<number>} how long the process took to exit, in milliseconds
   */
  async stopDaemon(signal = 'SIGKILL') {
    if (!this.daemon) return 0;

    const daemon = this.daemon;
    const startedAt = Date.now();
    const exited = once(daemon, 'exit');
    daemon.kill(signal);

    /** @type {NodeJS.Timeout | undefined} */
    let guard;
    const refusedToDie = new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error(`the daemon ignored ${signal} for 15s`)), 15_000);
    });

    try {
      await Promise.race([exited, refusedToDie]);
    } catch (error) {
      // Leaving a live daemon behind would poison every test after this one.
      daemon.kill('SIGKILL');
      await exited;
      throw error;
    } finally {
      clearTimeout(guard);
    }

    const elapsed = Date.now() - startedAt;
    this.daemon = null;

    await this.#waitOrExplain(
      'the backend to notice the node is gone',
      async () => (await this.health()).hardwareOnline === false
    );

    return elapsed;
  }

  async stop() {
    await this.stopDaemon('SIGKILL').catch(() => {});
    if (this.backend) {
      const exited = once(this.backend, 'exit');
      this.backend.kill('SIGTERM');
      await exited;
      this.backend = null;
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** @returns {Promise<any>} */
  async health() {
    const response = await fetch(`${this.baseUrl}/health`);
    return response.json();
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: any, admin?: boolean }} [options]
   * @returns {Promise<{ status: number, body: any }>}
   */
  async json(method, path, options = {}) {
    /** @type {Record<string, string>} */
    const headers = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.admin) {
      const credentials = Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  /** What the thermal printer would have burned onto paper. */
  spool() {
    return existsSync(this.spoolPath) ? readFileSync(this.spoolPath, 'utf8') : '';
  }

  logs() {
    return this.transcript.join('');
  }

  /**
   * A timed-out boot is almost always the child complaining on stderr, so say what it said.
   *
   * @param {string} label
   * @param {() => Promise<unknown>} probe
   */
  async #waitOrExplain(label, probe) {
    try {
      await waitUntil(label, probe);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason}\n--- process output ---\n${this.logs() || '(silence)'}`);
    }
  }

  /**
   * @param {string} label
   * @param {string} command
   * @param {string[]} args
   * @param {string} cwd
   * @param {Record<string, string>} env
   */
  #spawn(label, command, args, cwd, env) {
    // A filtered environment on purpose: whatever the developer exported for their own
    // machine must not decide how this test behaves.
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    for (const pipe of [child.stdout, child.stderr]) {
      pipe?.setEncoding('utf8');
      pipe?.on('data', (chunk) => this.transcript.push(`[${label}] ${chunk}`));
    }

    child.on('error', (error) => {
      this.transcript.push(`[${label}] could not start: ${error.message}\n`);
    });

    return child;
  }
}
