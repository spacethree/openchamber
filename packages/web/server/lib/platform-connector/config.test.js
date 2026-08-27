import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPlatformConnectorConfigStore } from './config.js';

const CONFIG = {
  platformUrl: 'https://platform.test',
  siteId: 'site-1',
  serverId: 'srv-1',
  serverToken: 'server-token-must-never-be-logged',
  name: 'mill-box',
  enrolledAt: '2026-08-27T12:00:00.000Z',
};

let dataDir;
let store;

const modeOf = async (target) => (await fsPromises.stat(target)).mode & 0o777;

beforeEach(async () => {
  dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'platform-connector-config-'));
  store = createPlatformConnectorConfigStore({ dataDir });
});

afterEach(async () => {
  await fsPromises.rm(dataDir, { recursive: true, force: true });
});

describe('platform connector config store', () => {
  it('round-trips the enrolled identity', async () => {
    await store.save(CONFIG);
    await expect(store.load()).resolves.toEqual({ ...CONFIG, revokedAt: null });
  });

  it('writes the config file owner-readable only', async () => {
    await store.save(CONFIG);
    await expect(modeOf(store.filePath)).resolves.toBe(0o600);
  });

  it('restores owner-only permissions on a file left world-readable', async () => {
    await store.save(CONFIG);
    await fsPromises.chmod(store.filePath, 0o644);

    await store.save({ ...CONFIG, revokedAt: '2026-08-27T13:00:00.000Z' });

    await expect(modeOf(store.filePath)).resolves.toBe(0o600);
    await expect(store.load()).resolves.toMatchObject({ revokedAt: '2026-08-27T13:00:00.000Z' });
  });

  it('creates a missing data directory owner-only', async () => {
    const nested = path.join(dataDir, 'nested');
    const nestedStore = createPlatformConnectorConfigStore({ dataDir: nested });

    await nestedStore.save(CONFIG);

    await expect(modeOf(nested)).resolves.toBe(0o700);
  });

  it('persists only the fields the connector owns', async () => {
    await store.save({ ...CONFIG, secretsWeDoNotOwn: 'drop me' });

    const raw = JSON.parse(await fsPromises.readFile(store.filePath, 'utf8'));
    expect(Object.keys(raw).sort()).toEqual([
      'enrolledAt', 'name', 'platformUrl', 'serverId', 'serverToken', 'siteId',
    ]);
  });

  it('reads a missing file as unenrolled', async () => {
    await expect(store.load()).resolves.toBeNull();
  });

  it('reads a malformed file as unenrolled instead of throwing', async () => {
    await fsPromises.writeFile(store.filePath, '{ not json', { mode: 0o600 });
    await expect(store.load()).resolves.toBeNull();
  });

  it('rejects a config that carries no bearer', async () => {
    await fsPromises.writeFile(store.filePath, JSON.stringify({ platformUrl: 'https://platform.test' }), { mode: 0o600 });
    await expect(store.load()).resolves.toBeNull();
  });
});
