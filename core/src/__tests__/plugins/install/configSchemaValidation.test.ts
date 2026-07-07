// Adaptation note: the D1b task-1 brief exercises the private
// `validateMetadata` through a `TestInstaller` subclass with
// `@ts-expect-error`. `PluginInstaller.test.ts` already exercises the same
// private method through the public `install()` path (see its "permission
// manifest validation" describe block), so this file mirrors that pattern
// instead — construct a backend that returns the candidate metadata, then
// assert on `install()`'s resolution/rejection.
import { describe, it, expect, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { PluginInstaller } from '../../../plugins/install/PluginInstaller.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from '../../../plugins/install/types.js';

const baseMeta: PluginMetadata = {
  id: 'cfg-plugin',
  type: PluginType.COMPILER,
  name: 'Cfg',
  version: '1.0.0',
  baseImage: 'ignite/installed_cfg-plugin:1.0.0',
};

const gitSource: PluginInstallSource = {
  kind: 'git',
  url: 'https://github.com/acme/cfg-plugin',
};

function makeDeps() {
  const store: Record<string, PluginMetadata> = {};
  const sources: Record<string, PluginInstallSource> = {};
  return {
    pluginManager: {
      addPlugin: vi.fn(
        async (m: PluginMetadata, source?: PluginInstallSource) => {
          store[m.id] = m;
          if (source) sources[m.id] = source;
        }
      ),
      removePlugin: vi.fn(async (id: string) => {
        delete store[id];
        delete sources[id];
      }),
      hasPlugin: vi.fn(async (id: string) => id in store),
      getPlugin: vi.fn(async (id: string) => store[id]),
      getInstallSource: vi.fn(async (id: string) => sources[id]),
    },
    loader: { isBuiltin: vi.fn(async () => false) },
    trust: {
      revoke: vi.fn(async () => {}),
      getGrant: vi.fn(async () => ({
        trust: 'untrusted' as const,
        hostWrite: false,
        net: false,
      })),
      setTrust: vi.fn(async () => {}),
    },
    removeImage: vi.fn(async () => {}),
    removeVolume: vi.fn(async () => {}),
    inspectRemote: vi.fn(async () => ({
      defaultBranch: 'main',
      branches: ['main'],
      releases: [],
    })),
    store,
    sources,
  };
}

function backendReturning(result: PluginBuildResult): PluginBuildBackend {
  return { buildPluginImage: vi.fn(async () => result) };
}

describe('validateConfigSchema (via install)', () => {
  it('accepts a valid schema (all field types)', async () => {
    const deps = makeDeps();
    const backend = backendReturning({
      imageTag: baseMeta.baseImage,
      metadata: {
        ...baseMeta,
        configFields: [
          { key: 'api-url', label: 'API URL', type: 'string' },
          { key: 'runs', label: 'Runs', type: 'number' },
          { key: 'enabled', label: 'Enabled', type: 'boolean' },
          {
            key: 'network',
            label: 'Network',
            type: 'select',
            options: [{ value: 'a', label: 'A' }],
          },
          { key: 'api-key', label: 'API Key', type: 'string', secret: true },
          { key: 'rpc', label: 'RPC', type: 'string', perChain: true },
        ],
      },
    });
    const installer = new PluginInstaller(backend, deps);
    await expect(installer.install(gitSource)).resolves.toMatchObject({
      id: 'cfg-plugin',
    });
  });

  it('accepts absent configFields (backward compatible)', async () => {
    const deps = makeDeps();
    const backend = backendReturning({
      imageTag: baseMeta.baseImage,
      metadata: baseMeta,
    });
    const installer = new PluginInstaller(backend, deps);
    await expect(installer.install(gitSource)).resolves.toMatchObject({
      id: 'cfg-plugin',
    });
  });

  const cases: Array<[string, unknown, RegExp]> = [
    ['non-array configFields', {}, /config/i],
    [
      'too many fields',
      Array.from({ length: 33 }, (_, i) => ({
        key: `k${i}`,
        label: 'L',
        type: 'string',
      })),
      /too many/i,
    ],
    [
      'a bad key',
      [{ key: 'Bad Key', label: 'L', type: 'string' }],
      /key/i,
    ],
    [
      'duplicate keys',
      [
        { key: 'dup', label: 'A', type: 'string' },
        { key: 'dup', label: 'B', type: 'string' },
      ],
      /duplicate/i,
    ],
    [
      'an unknown type',
      [{ key: 'k', label: 'L', type: 'date' }],
      /type/i,
    ],
    [
      'select without options',
      [{ key: 'k', label: 'L', type: 'select' }],
      /option/i,
    ],
    [
      'a label that is too long',
      [{ key: 'k', label: 'x'.repeat(281), type: 'string' }],
      /label/i,
    ],
    [
      'control characters in description',
      [
        {
          key: 'k',
          label: 'L',
          type: 'string',
          description: 'ab',
        },
      ],
      /control/i,
    ],
  ];

  for (const [name, configFields, messagePattern] of cases) {
    it(`rejects ${name}`, async () => {
      const deps = makeDeps();
      const backend = backendReturning({
        imageTag: baseMeta.baseImage,
        metadata: { ...baseMeta, configFields } as PluginMetadata,
      });
      const installer = new PluginInstaller(backend, deps);
      await expect(installer.install(gitSource)).rejects.toMatchObject({
        code: 'PLUGIN_INSTALL_INVALID',
        message: expect.stringMatching(messagePattern),
      });
      expect(deps.removeImage).toHaveBeenCalledWith(baseMeta.baseImage);
    });
  }
});
