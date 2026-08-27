import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlatformConnectorRuntime } from './runtime.js';

const ENROLL_TOKEN = 'enroll-token-must-never-be-logged';
const SERVER_TOKEN = 'server-token-must-never-be-logged';
const PLATFORM_URL = 'https://platform.test';

const CAPABILITIES = {
  uiUrl: 'http://127.0.0.1:3003',
  openchamberVersion: '1.21.0',
  opencodeVersion: '1.18.23',
  models: ['openai/gpt-5.5'],
  agents: ['build'],
  projects: ['/repo/app'],
};

const createLogger = () => {
  const lines = [];
  const record = (level) => (...args) => {
    lines.push(`${level} ${args.map((value) => String(value)).join(' ')}`);
  };
  return {
    lines,
    text: () => lines.join('\n'),
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
  };
};

let dataDir;

const configPath = () => path.join(dataDir, 'platform-connector.json');

const readConfigFile = async () => JSON.parse(await fsPromises.readFile(configPath(), 'utf8'));

const seedEnrolledConfig = async (overrides = {}) => {
  await fsPromises.writeFile(configPath(), JSON.stringify({
    platformUrl: PLATFORM_URL,
    siteId: 'site-1',
    serverId: 'srv-1',
    serverToken: SERVER_TOKEN,
    name: 'mill-box',
    enrolledAt: '2026-08-27T11:00:00.000Z',
    ...overrides,
  }), { mode: 0o600 });
};

const okHeartbeat = () => Response.json({ ok: true, serverId: 'srv-1', serverTime: '2026-08-27T12:00:00.000Z' });

const createRuntime = ({ fetchImpl, logger, env, collectCapabilities, heartbeatIntervalMs = 30_000 } = {}) => (
  createPlatformConnectorRuntime({
    logger: logger ?? createLogger(),
    dataDir,
    env: env ?? {},
    fetchImpl,
    collectCapabilities: collectCapabilities ?? (async () => CAPABILITIES),
    heartbeatIntervalMs,
    now: () => Date.parse('2026-08-27T12:00:00.000Z'),
  })
);

beforeEach(async () => {
  dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'platform-connector-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await fsPromises.rm(dataDir, { recursive: true, force: true });
});

describe('platform connector enrollment', () => {
  it('redeems the one-time token, persists the issued bearer, and logs no token', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith('/enroll')
        ? Response.json({ serverId: 'srv-1', siteId: 'site-1', serverToken: SERVER_TOKEN })
        : okHeartbeat();
    });
    const logger = createLogger();
    const runtime = createRuntime({
      fetchImpl,
      logger,
      env: {
        OPENCHAMBER_PLATFORM_URL: PLATFORM_URL,
        OPENCHAMBER_PLATFORM_ENROLL_TOKEN: ENROLL_TOKEN,
        OPENCHAMBER_PLATFORM_SERVER_NAME: 'mill-box',
      },
    });

    await runtime.start();
    runtime.stop();

    expect(calls[0].url).toBe('https://platform.test/api/work/mill/enroll');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      token: ENROLL_TOKEN,
      name: 'mill-box',
      capabilities: CAPABILITIES,
    });

    await expect(readConfigFile()).resolves.toEqual({
      platformUrl: PLATFORM_URL,
      siteId: 'site-1',
      serverId: 'srv-1',
      serverToken: SERVER_TOKEN,
      name: 'mill-box',
      enrolledAt: '2026-08-27T12:00:00.000Z',
    });

    expect(logger.text()).not.toContain(ENROLL_TOKEN);
    expect(logger.text()).not.toContain(SERVER_TOKEN);
  });

  it('names the server after the hostname when the env does not', async () => {
    const fetchImpl = vi.fn(async (url) => (String(url).endsWith('/enroll')
      ? Response.json({ serverId: 'srv-1', siteId: 'site-1', serverToken: SERVER_TOKEN })
      : okHeartbeat()));
    const runtime = createRuntime({
      fetchImpl,
      env: { OPENCHAMBER_PLATFORM_URL: PLATFORM_URL, OPENCHAMBER_PLATFORM_ENROLL_TOKEN: ENROLL_TOKEN },
    });

    await runtime.start();
    runtime.stop();

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).name).toBe(os.hostname());
  });

  it('stays unenrolled after a rejected token, writes no config, and leaks no token', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const logger = createLogger();
    const runtime = createRuntime({
      fetchImpl,
      logger,
      env: { OPENCHAMBER_PLATFORM_URL: PLATFORM_URL, OPENCHAMBER_PLATFORM_ENROLL_TOKEN: ENROLL_TOKEN },
    });

    await runtime.start();
    runtime.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fsPromises.readFile(configPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runtime.getStatus()).toMatchObject({ enrolled: false, status: 'unenrolled' });
    expect(logger.text()).toContain('401');
    expect(logger.text()).not.toContain(ENROLL_TOKEN);
  });

  it('does not attempt enrollment without both platform URL and enrollment token', async () => {
    const fetchImpl = vi.fn(async () => okHeartbeat());
    const runtime = createRuntime({ fetchImpl, env: { OPENCHAMBER_PLATFORM_URL: PLATFORM_URL } });

    await runtime.start();
    runtime.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({ enrolled: false, status: 'unenrolled', platformUrl: null });
  });

  it('re-enrolls after a revoke when a fresh enrollment token is supplied', async () => {
    await seedEnrolledConfig({ revokedAt: '2026-08-27T16:00:00.000Z' });
    const fetchImpl = vi.fn(async (url) => (String(url).endsWith('/enroll')
      ? new Response(JSON.stringify({ serverId: 'srv-2', siteId: 'site-1', serverToken: 'mill_srv_fresh' }), { status: 200 })
      : okHeartbeat()));
    const runtime = createRuntime({
      fetchImpl,
      env: { OPENCHAMBER_PLATFORM_URL: PLATFORM_URL, OPENCHAMBER_PLATFORM_ENROLL_TOKEN: 'mill_enroll_fresh' },
    });

    await runtime.start();
    runtime.stop();

    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${PLATFORM_URL}/api/work/mill/enroll`);
    expect(runtime.getStatus()).toMatchObject({ enrolled: true, status: 'connected', serverId: 'srv-2' });
    const stored = JSON.parse(await fsPromises.readFile(configPath(), 'utf8'));
    expect(stored.revokedAt).toBeUndefined();
    expect(stored.serverToken).toBe('mill_srv_fresh');
  });

  it('stays revoked when no fresh enrollment token is supplied', async () => {
    await seedEnrolledConfig({ revokedAt: '2026-08-27T16:00:00.000Z' });
    const fetchImpl = vi.fn(async () => okHeartbeat());
    const runtime = createRuntime({ fetchImpl, env: { OPENCHAMBER_PLATFORM_URL: PLATFORM_URL } });

    await runtime.start();
    runtime.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({ enrolled: false, status: 'revoked' });
  });

  it('ignores enrollment env once a bearer is stored', async () => {
    await seedEnrolledConfig();
    const fetchImpl = vi.fn(async () => okHeartbeat());
    const runtime = createRuntime({
      fetchImpl,
      env: { OPENCHAMBER_PLATFORM_URL: 'https://other.test', OPENCHAMBER_PLATFORM_ENROLL_TOKEN: ENROLL_TOKEN },
    });

    await runtime.start();
    runtime.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://platform.test/api/work/mill/heartbeat');
  });
});

describe('platform connector heartbeat', () => {
  it('sends the bearer and freshly collected capabilities on every tick', async () => {
    vi.useFakeTimers();
    await seedEnrolledConfig();
    const fetchImpl = vi.fn(async () => okHeartbeat());
    const collectCapabilities = vi.fn(async () => CAPABILITIES);
    const runtime = createRuntime({ fetchImpl, collectCapabilities });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    runtime.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(collectCapabilities).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toBe('https://platform.test/api/work/mill/heartbeat');
      expect(init.headers.authorization).toBe(`Bearer ${SERVER_TOKEN}`);
      expect(JSON.parse(init.body)).toEqual({ capabilities: CAPABILITIES });
    }
    expect(runtime.getStatus()).toMatchObject({
      enrolled: true,
      status: 'connected',
      siteId: 'site-1',
      serverId: 'srv-1',
      name: 'mill-box',
      platformUrl: PLATFORM_URL,
      lastHeartbeatAt: '2026-08-27T12:00:00.000Z',
      lastError: null,
    });
  });

  it('never exposes the bearer through getStatus', async () => {
    await seedEnrolledConfig();
    const runtime = createRuntime({ fetchImpl: vi.fn(async () => okHeartbeat()) });

    await runtime.start();
    runtime.stop();

    expect(JSON.stringify(runtime.getStatus())).not.toContain(SERVER_TOKEN);
  });

  it('marks the connector revoked on a 401, persists revokedAt, and stops the loop', async () => {
    vi.useFakeTimers();
    await seedEnrolledConfig();
    const fetchImpl = vi.fn(async () => new Response('revoked', { status: 401 }));
    const logger = createLogger();
    const runtime = createRuntime({ fetchImpl, logger });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(300_000);
    runtime.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toMatchObject({ enrolled: false, status: 'revoked' });
    await expect(readConfigFile()).resolves.toMatchObject({ revokedAt: '2026-08-27T12:00:00.000Z' });
    expect(logger.text()).not.toContain(SERVER_TOKEN);
  });

  it('stays revoked in memory when the revocation cannot be written to disk', async () => {
    vi.useFakeTimers();
    await seedEnrolledConfig();
    const fetchImpl = vi.fn(async () => new Response('revoked', { status: 401 }));
    const logger = createLogger();
    const runtime = createRuntime({ fetchImpl, logger });

    await fsPromises.chmod(dataDir, 0o500);
    try {
      await runtime.start();
      await vi.advanceTimersByTimeAsync(120_000);
    } finally {
      await fsPromises.chmod(dataDir, 0o700);
    }
    runtime.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toMatchObject({ enrolled: false, status: 'revoked' });
    expect(logger.text()).toContain('could not record the revocation on disk');
  });

  it('never heartbeats again after a revocation survives a restart', async () => {
    await seedEnrolledConfig({ revokedAt: '2026-08-27T11:30:00.000Z' });
    const fetchImpl = vi.fn(async () => okHeartbeat());
    const runtime = createRuntime({ fetchImpl });

    await runtime.start();
    runtime.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toMatchObject({ enrolled: false, status: 'revoked' });
  });

  it('keeps looping through network failures and logs once per state change', async () => {
    vi.useFakeTimers();
    await seedEnrolledConfig();
    let failing = true;
    const fetchImpl = vi.fn(async () => {
      if (failing) throw new Error('getaddrinfo ENOTFOUND platform.test');
      return okHeartbeat();
    });
    const logger = createLogger();
    const runtime = createRuntime({ fetchImpl, logger });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(runtime.getStatus()).toMatchObject({ status: 'error' });
    expect(runtime.getStatus().lastError).toContain('ENOTFOUND');
    expect(logger.lines.filter((line) => line.includes('ENOTFOUND'))).toHaveLength(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(30_000);
    runtime.stop();

    expect(runtime.getStatus()).toMatchObject({ status: 'connected', lastError: null });
  });

  it('reports a non-401 rejection as an error without revoking', async () => {
    vi.useFakeTimers();
    await seedEnrolledConfig();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }));
    const runtime = createRuntime({ fetchImpl });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(30_000);
    runtime.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(runtime.getStatus()).toMatchObject({ enrolled: true, status: 'error' });
    expect(runtime.getStatus().lastError).toContain('503');
    await expect(readConfigFile()).resolves.not.toHaveProperty('revokedAt');
  });
});

describe('platform connector lifecycle', () => {
  it('stop() clears the heartbeat timer', async () => {
    vi.useFakeTimers();
    await seedEnrolledConfig();
    const fetchImpl = vi.fn(async () => okHeartbeat());
    const runtime = createRuntime({ fetchImpl });

    await runtime.start();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    runtime.stop();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() is safe before start and repeatable', async () => {
    const runtime = createRuntime({ fetchImpl: vi.fn(async () => okHeartbeat()) });

    expect(() => {
      runtime.stop();
      runtime.stop();
    }).not.toThrow();
    expect(runtime.getStatus()).toMatchObject({ enrolled: false, status: 'unenrolled' });
  });
});
