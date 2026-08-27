import { describe, expect, it, vi } from 'vitest';

import { collectCapabilities } from './capabilities.js';

const PROVIDERS = {
  providers: [
    { id: 'openai', models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.5-codex' }] },
    { id: 'anthropic', models: { 'claude-sonnet-5': { id: 'claude-sonnet-5' } } },
  ],
};

const AGENTS = [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }];

const createOpenCodeFetch = (overrides = {}) => vi.fn(async (fetchPath) => {
  if (Object.hasOwn(overrides, fetchPath)) {
    const value = overrides[fetchPath];
    if (value instanceof Error) throw value;
    return value;
  }
  if (fetchPath === '/config/providers') return PROVIDERS;
  if (fetchPath === '/agent') return AGENTS;
  if (fetchPath === '/global/health') return { version: 'v1.18.23' };
  return null;
});

const executeAction = vi.fn(async (action) => {
  if (action === 'projects.list') {
    return { projects: [{ id: 'p1', path: '/repo/app', label: 'app' }, { id: 'p2', path: '/repo/site', label: 'site' }] };
  }
  if (action === 'models.list') {
    return { defaultModel: 'openai/gpt-5.5', favoriteModels: ['openai/gpt-5.5'], recentModels: ['anthropic/claude-sonnet-5'] };
  }
  return null;
});

describe('capability collection', () => {
  it('reports the model catalog, agents, projects, and versions', async () => {
    await expect(collectCapabilities({
      executeAction,
      openCodeFetch: createOpenCodeFetch(),
      versions: { openchamberVersion: '1.21.0', uiUrl: 'http://127.0.0.1:3003' },
    })).resolves.toEqual({
      uiUrl: 'http://127.0.0.1:3003',
      openchamberVersion: '1.21.0',
      opencodeVersion: '1.18.23',
      models: ['anthropic/claude-sonnet-5', 'openai/gpt-5.5', 'openai/gpt-5.5-codex'],
      agents: ['build', 'plan'],
      projects: ['/repo/app', '/repo/site'],
    });
  });

  it('omits uiUrl when the caller has none', async () => {
    const capabilities = await collectCapabilities({
      executeAction,
      openCodeFetch: createOpenCodeFetch(),
      versions: { openchamberVersion: '1.21.0' },
    });
    expect(capabilities).not.toHaveProperty('uiUrl');
  });

  it('prefers the version the caller already knows over a probe', async () => {
    const openCodeFetch = createOpenCodeFetch();
    const capabilities = await collectCapabilities({
      executeAction,
      openCodeFetch,
      versions: { openchamberVersion: '1.21.0', opencodeVersion: '1.18.24' },
    });

    expect(capabilities.opencodeVersion).toBe('1.18.24');
    expect(openCodeFetch).not.toHaveBeenCalledWith('/global/health');
  });

  it('falls back to the recorded model preferences when the catalog is unavailable', async () => {
    const capabilities = await collectCapabilities({
      executeAction,
      openCodeFetch: createOpenCodeFetch({ '/config/providers': new Error('OpenCode is down') }),
      versions: { openchamberVersion: '1.21.0' },
    });

    expect(capabilities.models).toEqual(['anthropic/claude-sonnet-5', 'openai/gpt-5.5']);
  });

  it('reports an empty list per field that fails rather than failing the whole report', async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const capabilities = await collectCapabilities({
      executeAction: async () => { throw new Error('control service unavailable'); },
      openCodeFetch: createOpenCodeFetch({
        '/config/providers': new Error('OpenCode is down'),
        '/agent': new Error('OpenCode is down'),
        '/global/health': new Error('OpenCode is down'),
      }),
      versions: { openchamberVersion: '1.21.0' },
      logger,
    });

    expect(capabilities).toEqual({
      openchamberVersion: '1.21.0',
      opencodeVersion: null,
      models: [],
      agents: [],
      projects: [],
    });
    expect(logger.debug).toHaveBeenCalled();
  });

  it('reports empty lists when no OpenCode or control access was supplied', async () => {
    await expect(collectCapabilities({ versions: { openchamberVersion: '1.21.0' } })).resolves.toEqual({
      openchamberVersion: '1.21.0',
      opencodeVersion: null,
      models: [],
      agents: [],
      projects: [],
    });
  });
});
