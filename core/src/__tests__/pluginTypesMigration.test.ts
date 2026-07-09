import { describe, it, expect } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import { normalizeLegacyType } from '../plugins/utils/permissionCompat.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { NATIVE_GRANT } from '../plugins/trust/TrustManager.js';
import { ContainerLifecycle } from '../plugins/containers/ContainerOrchestrator.js';
import type { PluginConfig } from '../assets/PluginRegistryLoader.js';
import type { PermissionGrant } from '../plugins/trust/TrustManager.js';

describe('normalizeLegacyType', () => {
  it('passes through a modern multi-type manifest unchanged', () => {
    const metadata = {
      id: 'chainz',
      types: [PluginType.RPC_PROVIDER, PluginType.SIGNER_PROVIDER],
      name: 'Chainz',
      version: '1.0.0',
      baseImage: 'x',
    };
    expect(normalizeLegacyType(metadata as never).types).toEqual([
      PluginType.RPC_PROVIDER,
      PluginType.SIGNER_PROVIDER,
    ]);
  });

  it('normalizes a legacy single-type manifest to types[]', () => {
    const legacy = {
      id: 'waffle',
      type: PluginType.COMPILER,
      name: 'Waffle',
      version: '1.0.0',
      baseImage: 'x',
    };
    const normalized = normalizeLegacyType(legacy as never);
    expect(normalized.types).toEqual([PluginType.COMPILER]);
    expect('type' in normalized).toBe(false);
  });

  it('exposes signer-provider as a plugin type', () => {
    expect(PluginType.SIGNER_PROVIDER).toBe('signer-provider');
  });
});

describe('PluginExecutor signer-provider network clamp', () => {
  const signerConfig: PluginConfig = {
    origin: 'builtin',
    requiresRepo: false,
    metadata: {
      id: 'native-signer',
      types: [PluginType.SIGNER_PROVIDER],
      name: 'Native Signer',
      version: '1.0.0',
      baseImage: 'ignite/native-signer:latest',
    },
  };

  function makeExecutor(seenGrants: PermissionGrant[]) {
    return new PluginExecutor({
      registryLoader: {
        getPluginConfig: async () => signerConfig,
      },
      trust: {
        getGrant: async () => NATIVE_GRANT,
      },
      containerOrchestrator: {
        createContainer: async (opts) => {
          expect(opts.lifecycle).toBe(ContainerLifecycle.EPHEMERAL);
          seenGrants.push(opts.grant);
          return 'container-1';
        },
        stopContainer: async () => undefined,
        getContainer: () =>
          ({
            exec: async () => ({
              start: async () => {
                const stream = new ReadableStream();
                return Object.assign(stream, {
                  on: (_event: string, cb: () => void) => {
                    cb();
                    return stream;
                  },
                  resume: () => undefined,
                });
              },
            }),
          }) as never,
        cleanup: async () => undefined,
        cleanupDetached: () => undefined,
      },
      executeOperation: (async () => ({ success: true, data: {} })) as never,
      pluginConfigStore: { getValues: async () => ({}) },
      vaultStore: {
        getSecret: async () => undefined,
        listSecretKeys: async () => [],
      },
      getFileContents: async () => undefined,
      rebuildImage: async () => undefined,
    });
  }

  it('removes network for every signer-plugin op except sendTransaction', async () => {
    const seenGrants: PermissionGrant[] = [];
    const executor = makeExecutor(seenGrants);

    await executor.execute('native-signer', 'signTransaction', {});
    await executor.execute('native-signer', 'sendTransaction', {});
    // Config injection is not operation-scoped, so a multi-surface signer
    // plugin's OTHER surfaces' ops (e.g. chainz getSupportedChains) hold key
    // material too and must be clamped as well.
    await executor.execute('native-signer', 'getSupportedChains', {});

    expect(seenGrants[0].net).toBe(false);
    expect(seenGrants[1].net).toBe(true);
    expect(seenGrants[2].net).toBe(false);
  });
});
