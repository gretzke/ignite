import { describe, it, expect, beforeEach, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { PluginType } from '@ignite/plugin-types/types';
import { createInstallHandlers } from '../../api/plugins/install.js';
import { PluginError, ErrorCodes } from '../../types/errors.js';

const waffleMeta = {
  id: 'waffle',
  type: PluginType.COMPILER,
  name: 'Waffle',
  version: '1.0.0',
  baseImage: 'ignite/installed_waffle:1.0.0',
};

describe('install API handlers', () => {
  let app: FastifyInstance;
  const installer = {
    install: vi.fn(async () => waffleMeta),
    uninstall: vi.fn(async () => {}),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const handlers = createInstallHandlers(installer, {
      allowLocalSource: () => true,
    });
    app = fastify();
    app.post('/api/v1/plugins/install', handlers.installPlugin);
    app.delete('/api/v1/plugins/:pluginId', handlers.uninstallPlugin);
    await app.ready();
  });

  it('installs from a local source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { source: { kind: 'local', contextDir: '/src/waffle' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.plugin.id).toBe('waffle');
    expect(installer.install).toHaveBeenCalledWith({
      kind: 'local',
      contextDir: '/src/waffle',
    });
  });

  it('returns 400 when install rejects a built-in shadow', async () => {
    installer.install.mockRejectedValueOnce(
      new PluginError(
        "Cannot install 'foundry': it shadows a built-in plugin",
        ErrorCodes.PLUGIN_INSTALL_CONFLICT
      )
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { source: { kind: 'local', contextDir: '/src/foundry' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects local sources when local installs are not allowed', async () => {
    const handlers = createInstallHandlers(installer, {
      allowLocalSource: () => false,
    });
    const gated = fastify();
    gated.post('/api/v1/plugins/install', handlers.installPlugin);
    await gated.ready();

    const localRes = await gated.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { source: { kind: 'local', contextDir: '/src/waffle' } },
    });
    expect(localRes.statusCode).toBe(400);
    expect(localRes.json().code).toBe('PLUGIN_INSTALL_REJECTED');
    expect(installer.install).not.toHaveBeenCalled();

    const gitRes = await gated.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: {
        source: { kind: 'git', url: 'https://github.com/acme/waffle' },
      },
    });
    expect(gitRes.statusCode).toBe(200);
  });

  it('uninstalls a plugin', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/plugins/waffle',
    });
    expect(res.statusCode).toBe(204);
    expect(installer.uninstall).toHaveBeenCalledWith('waffle');
  });
});
