// End-to-end proof that the builtin (native) rpc-provider plugins work with
// ZERO trust-grant step: Infura ships in the bundled plugin registry, so
// TrustManager resolves it to NATIVE_GRANT and resolveConfig treats
// trust==='native' as all-declared-secrets-granted. The user only has to set
// the api-key in Configure — no Manage Permissions step — and endpoints
// appear. This test drives the REAL bundled registry (PluginRegistryLoader
// via AssetManager), the REAL TrustManager/VaultStore (sandboxed home, fake
// master key), and the REAL PluginExecutor against the built
// ignite/rpc-provider_infura Docker image:
//   1. infura/alchemy load from the bundled registry with origin 'builtin'
//      and their configFields intact
//   2. TrustManager resolves infura to trust 'native' and refuses to mutate
//      it (native trust is immutable — there IS no grant step)
//   3. before any key is stored, getEndpoints returns [] (the plugin sees no
//      config and reports no chains)
//   4. after storing the key in the vault — and touching NOTHING else, in
//      particular never calling setTrust — the Infura endpoint for chain 1
//      surfaces with the key embedded in the URL, proving the native
//      auto-grant path end to end.
import { describe, it, expect, afterAll } from 'vitest';
import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { FileSystem } from '../filesystem/FileSystem.js';

// Sandbox the ignite home BEFORE any singleton resolves it so nothing here
// touches the developer's real ~/.ignite (trust.json, vault.json, registry).
const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-builtin-provider-e2e-')
);
FileSystem.getInstance(IGNITE_HOME);

const { PluginRegistryLoader } = await import(
  '../assets/PluginRegistryLoader.js'
);
const { PluginExecutor } = await import(
  '../plugins/containers/PluginExecutor.js'
);
const { TrustManager } = await import('../plugins/trust/TrustManager.js');
const { VaultStore } = await import('../plugins/vault/VaultStore.js');
const { RpcProviderService } = await import('../chains/RpcProviderService.js');
const { PluginType } = await import('@ignite/plugin-types/types');

const docker = new Docker();
const API_KEY_VALUE = 'builtin-infura-key-do-not-leak';

// Requires the builtin plugin build (cd plugins && npm run build): the
// bundled registry must list infura and the ignite/rpc-provider_infura
// image must exist locally.
async function environmentReady(): Promise<boolean> {
  try {
    await docker.ping();
    await docker.getImage('ignite/rpc-provider_infura:latest').inspect();
    return true;
  } catch {
    return false;
  }
}
const ready = await environmentReady();

describe.skipIf(!ready)('builtin rpc-provider native trust (Docker)', () => {
  afterAll(async () => {
    await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('serves Infura endpoints from the bundled registry once the key is set, with no grant step', async () => {
    // --- 1. Builtin registry: infura and alchemy load with origin
    // 'builtin', type rpc-provider, and the secret api-key config field. ---
    const loader = PluginRegistryLoader.getInstance();
    const providers = await loader.getPluginsByType(PluginType.RPC_PROVIDER);
    const ids = providers.map((p) => p.metadata.id);
    expect(ids).toContain('infura');
    expect(ids).toContain('alchemy');

    const infura = await loader.getPluginConfig('infura');
    expect(infura.origin).toBe('builtin');
    expect(infura.metadata.type).toBe('rpc-provider');
    expect(infura.metadata.baseImage).toBe('ignite/rpc-provider_infura:latest');
    expect(infura.metadata.configFields).toEqual([
      expect.objectContaining({
        key: 'api-key',
        secret: true,
        required: true,
      }),
    ]);

    // --- 2. Native trust: the grant is 'native' (resolveConfig treats this
    // as all-declared-secrets-granted) and immutable — there is no
    // permissions step a user could even perform. ---
    const trust = TrustManager.getInstance();
    const grant = await trust.getGrant('infura');
    expect(grant.trust).toBe('native');
    await expect(
      trust.setTrust('infura', 'trusted', {
        repoWrite: false,
        net: false,
        secrets: ['api-key'],
      })
    ).rejects.toThrow(/native plugin infura is immutable/);

    // --- Real executor with a REAL VaultStore (fake in-memory master key —
    // never the OS keychain); provider list pinned to infura so the test
    // exercises exactly one real container run. ---
    const fakeMasterKey = Buffer.alloc(32, 9);
    const vaultStore = new VaultStore({
      getMasterKey: async () => fakeMasterKey,
    });
    const executor = new PluginExecutor({ vaultStore });
    const service = new RpcProviderService({
      getProviders: async () => [{ id: 'infura', name: 'Infura' }],
      execute: (pluginId, operation, options, opts) =>
        executor.execute(pluginId, operation, options, opts),
    });

    // --- 3. No key stored yet: the plugin (running in the real
    // ignite/rpc-provider_infura container via the builtin `node -e` bundle
    // injection path) sees no api-key and reports no chains. ---
    expect(await service.getEndpoints(1)).toEqual([]);

    // --- 4. Store the key. NOTHING else: no setTrust, no permission grant.
    // Native auto-grant must inject the secret and endpoints must appear. ---
    await vaultStore.setSecret('infura', 'api-key', API_KEY_VALUE);
    service.invalidate();

    const endpoints = await service.getEndpoints(1);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toEqual({
      id: 'plugin:infura:1:0',
      url: `https://mainnet.infura.io/v3/${API_KEY_VALUE}`,
      label: 'Infura Mainnet',
      source: 'plugin',
      pluginId: 'infura',
    });
  }, 240_000);
});
