import { describe, it, expect, vi } from 'vitest';
import fastify from 'fastify';
import { createVersionsHandlers } from '../../api/plugins/versions.js';
import type { PluginInstallSource } from '../../plugins/install/types.js';
import type { RemoteRefs } from '../../plugins/install/gitRemote.js';

const URL = 'https://github.com/acme/waffle';

async function callVersions(
  sources: Record<string, PluginInstallSource>,
  refs: RemoteRefs | Error
) {
  const handlers = createVersionsHandlers({
    listPlugins: vi.fn(async () =>
      Object.fromEntries(
        Object.keys(sources).map((id) => [id, { id, version: '1.0.0' }])
      )
    ),
    getInstallSource: vi.fn(async (id: string) => sources[id]),
    fetchRemoteRefs: vi.fn(async () => {
      if (refs instanceof Error) throw refs;
      return refs;
    }),
  });
  const app = fastify();
  app.get('/versions', handlers.pluginVersions);
  await app.ready();
  const res = await app.inject({ url: '/versions' });
  expect(res.statusCode).toBe(200);
  return res.json().data.plugins;
}

describe('pluginVersions handler', () => {
  it('branch tracking: update available when the remote head moved', async () => {
    const plugins = await callVersions(
      {
        waffle: {
          kind: 'git',
          url: URL,
          track: { mode: 'branch', branch: 'main' },
          commit: 'a'.repeat(40),
          description: 'A plugin',
        },
      },
      {
        defaultBranch: 'main',
        branches: { main: 'b'.repeat(40) },
        tags: {},
      }
    );
    expect(plugins[0]).toMatchObject({
      pluginId: 'waffle',
      source: 'git',
      track: 'branch',
      trackRef: 'main',
      description: 'A plugin',
      currentCommit: 'a'.repeat(40),
      latestCommit: 'b'.repeat(40),
      updateAvailable: true,
    });
  });

  it('branch tracking: no update when head matches', async () => {
    const plugins = await callVersions(
      {
        waffle: {
          kind: 'git',
          url: URL,
          track: { mode: 'branch', branch: 'main' },
          commit: 'a'.repeat(40),
        },
      },
      { defaultBranch: 'main', branches: { main: 'a'.repeat(40) }, tags: {} }
    );
    expect(plugins[0].updateAvailable).toBe(false);
  });

  it('release tracking: newer stable semver tag triggers an update (prereleases ignored)', async () => {
    const plugins = await callVersions(
      {
        waffle: {
          kind: 'git',
          url: URL,
          track: { mode: 'release', version: 'v0.4.0' },
          commit: 'a'.repeat(40),
        },
      },
      {
        defaultBranch: 'main',
        branches: {},
        tags: {
          'v0.4.0': 'a'.repeat(40),
          'v0.5.0': 'b'.repeat(40),
          'v0.6.0-rc.1': 'c'.repeat(40),
        },
      }
    );
    expect(plugins[0]).toMatchObject({
      track: 'release',
      currentVersion: '0.4.0',
      latestVersion: '0.5.0',
      updateAvailable: true,
    });
  });

  it('release tracking: no update when already newest', async () => {
    const plugins = await callVersions(
      {
        waffle: {
          kind: 'git',
          url: URL,
          track: { mode: 'release', version: 'v0.5.0' },
        },
      },
      {
        defaultBranch: 'main',
        branches: {},
        tags: { 'v0.4.0': 'a'.repeat(40), 'v0.5.0': 'b'.repeat(40) },
      }
    );
    expect(plugins[0].updateAvailable).toBe(false);
  });

  it('pinned commits and local installs never prompt; remote failures degrade to checkError', async () => {
    const plugins = await callVersions(
      {
        pinned: {
          kind: 'git',
          url: URL,
          track: { mode: 'commit' },
          commit: 'a'.repeat(40),
        },
        local: { kind: 'local', contextDir: '/x' },
        broken: {
          kind: 'git',
          url: URL,
          track: { mode: 'branch', branch: 'main' },
          commit: 'a'.repeat(40),
        },
      },
      new Error('offline')
    );
    const byId = Object.fromEntries(
      plugins.map((p: { pluginId: string }) => [p.pluginId, p])
    );
    expect(byId.pinned.updateAvailable).toBe(false);
    expect(byId.pinned.checkError).toBeUndefined(); // pinned never hits the remote
    expect(byId.local).toMatchObject({
      source: 'local',
      updateAvailable: false,
    });
    expect(byId.broken).toMatchObject({
      updateAvailable: false,
      checkError: 'offline',
    });
  });
});
