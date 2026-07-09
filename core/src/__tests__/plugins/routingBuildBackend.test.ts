import { describe, it, expect, vi } from 'vitest';
import { RoutingBuildBackend } from '../../plugins/install/RoutingBuildBackend.js';
import { PluginType } from '@ignite/plugin-types/types';

const result = {
  imageTag: 'ignite/installed_x:1.0.0',
  metadata: {
    id: 'x',
    types: [PluginType.COMPILER],
    name: 'X',
    version: '1.0.0',
    baseImage: 'ignite/installed_x:1.0.0',
  },
};

describe('RoutingBuildBackend', () => {
  it('routes local sources to the local backend', async () => {
    const local = { buildPluginImage: vi.fn(async () => result) };
    const git = { buildPluginImage: vi.fn(async () => result) };
    const backend = new RoutingBuildBackend(local, git);
    await backend.buildPluginImage({ kind: 'local', contextDir: '/x' });
    expect(local.buildPluginImage).toHaveBeenCalledOnce();
    expect(git.buildPluginImage).not.toHaveBeenCalled();
  });

  it('routes git sources to the git backend', async () => {
    const local = { buildPluginImage: vi.fn(async () => result) };
    const git = { buildPluginImage: vi.fn(async () => result) };
    const backend = new RoutingBuildBackend(local, git);
    await backend.buildPluginImage({ kind: 'git', url: 'https://x/y' });
    expect(git.buildPluginImage).toHaveBeenCalledOnce();
    expect(local.buildPluginImage).not.toHaveBeenCalled();
  });
});
