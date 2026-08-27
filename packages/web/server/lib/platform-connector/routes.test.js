import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerPlatformConnectorRoutes } from './routes.js';

const STATUS = {
  enrolled: true,
  platformUrl: 'https://platform.test',
  siteId: 'site-1',
  serverId: 'srv-1',
  name: 'mill-box',
  status: 'connected',
  lastHeartbeatAt: '2026-08-27T12:00:00.000Z',
  lastError: null,
};

const createApp = (getStatus) => {
  const app = express();
  registerPlatformConnectorRoutes(app, { runtime: { getStatus } });
  return app;
};

describe('platform connector status route', () => {
  it('returns the connector status', async () => {
    const response = await request(createApp(() => STATUS))
      .get('/api/openchamber/platform-connector/status')
      .expect(200);

    expect(response.body).toEqual(STATUS);
  });

  it('reports the failure instead of an empty status when the runtime throws', async () => {
    const response = await request(createApp(() => { throw new Error('runtime unavailable'); }))
      .get('/api/openchamber/platform-connector/status')
      .expect(500);

    expect(response.body).toEqual({ error: 'runtime unavailable' });
  });
});
