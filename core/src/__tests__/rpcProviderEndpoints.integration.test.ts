// End-to-end proof of the rpc-provider endpoint feature (D1c): a third-party
// rpc-provider plugin declares one secret config field (api-key) and only
// reports supported chains when core injected that secret. This test installs
// it through the REAL PluginInstaller, stores the key through the REAL
// VaultStore (fake in-memory master key — never the OS keychain), and drives
// RpcProviderService through the REAL PluginExecutor + Docker + registry to
// prove:
//   1. without a secret grant the plugin sees no key → getEndpoints === []
//   2. with `secrets: ['api-key']` granted (+ cache invalidate) exactly one
//      endpoint surfaces: the chainId-1 entry with a synthetic id, source
//      'plugin', and the key embedded in the url
//   3. the malformed entries the fixture deliberately returns (chainId 999
//      with a non-url, chainId -5) are dropped by core-side validation
//   4. the key-embedding url never appears in non-result job-log output or
//      core log lines — it only travels inside the sentinel-framed RESULT
//      block and the in-memory endpoint list.
//
// This closes the ROADMAP D1 exit criterion "verify RPCs including
// plugin-provided endpoints"; see RpcProviderService.ts for the production
// code under test and pluginConfigInjection.integration.test.ts for the
// secret-injection pipeline this rides on.
import { describe, it, expect, afterAll } from 'vitest';
import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileSystem } from '../filesystem/FileSystem.js';

// Sandbox the ignite home BEFORE any singleton resolves it (see
// pluginConfigInjection.integration.test.ts) so nothing here ever touches the
// developer's real ~/.ignite — including trust.json, vault.json, and the
// installed-plugin registry.
const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-provider-e2e-')
);
FileSystem.getInstance(IGNITE_HOME);

const { PluginInstaller } = await import(
  '../plugins/install/PluginInstaller.js'
);
const { LocalFolderBuildBackend } = await import(
  '../plugins/install/LocalFolderBuildBackend.js'
);
const { PluginExecutor } = await import(
  '../plugins/containers/PluginExecutor.js'
);
const { TrustManager } = await import('../plugins/trust/TrustManager.js');
const { VaultStore } = await import('../plugins/vault/VaultStore.js');
const { RpcProviderService } = await import('../chains/RpcProviderService.js');
const { setGlobalLogger } = await import('../utils/logger.js');

const docker = new Docker();
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'provider-fixture'
);
const PLUGIN_ID = 'provider-fixture';
const API_KEY_VALUE = 'sk-provider-secret-key-do-not-leak';
const SECRET_URL = `https://rpc.example.com/${API_KEY_VALUE}`;

async function dockerReady(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}
const ready = await dockerReady();

describe.skipIf(!ready)('rpc-provider plugin endpoints (Docker)', () => {
  const installer = new PluginInstaller(new LocalFolderBuildBackend());

  afterAll(async () => {
    try {
      await installer.uninstall(PLUGIN_ID);
    } catch {
      /* best effort */
    }
    await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('surfaces plugin endpoints only under a secret grant, validated, without leaking the key', async () => {
    // Capture every core log line for the duration of the test: the
    // key-embedding provider URL must never be logged (SPEC §6.8).
    const coreLogLines: string[] = [];
    const capture = (message: string, ...args: unknown[]) => {
      coreLogLines.push([message, ...args.map(String)].join(' '));
    };
    setGlobalLogger({
      info: capture,
      warn: capture,
      error: capture,
      debug: capture,
    });

    // --- Install the fixture through the real installer. ---
    const meta = await installer.install({
      kind: 'local',
      contextDir: FIXTURE,
      dockerfile: 'Dockerfile',
    });
    expect(meta.id).toBe(PLUGIN_ID);
    expect(meta.type).toBe('rpc-provider');
    expect(meta.configFields?.map((f) => f.key)).toEqual(['api-key']);

    // --- Store the key in the REAL VaultStore (fake master key: fixed
    // 32-byte buffer, never the OS keychain). This is the ONLY VaultStore
    // the executor under test ever sees. ---
    const fakeMasterKey = Buffer.alloc(32, 7);
    const vaultStore = new VaultStore({
      getMasterKey: async () => fakeMasterKey,
    });
    await vaultStore.setSecret(PLUGIN_ID, 'api-key', API_KEY_VALUE);

    // --- REAL executor (with the fake-key vault) + REAL registry-backed
    // provider discovery (RpcProviderService's default getProviders reads
    // the installed-plugin registry under the sandboxed IGNITE_HOME). Job
    // log output is captured for the leak assertion. ---
    const executor = new PluginExecutor({ vaultStore });
    const jobLogLines: string[] = [];
    const service = new RpcProviderService({
      execute: (pluginId, operation, options, opts) =>
        executor.execute(pluginId, operation, options, {
          ...opts,
          onOutput: (text) => jobLogLines.push(text),
        }),
    });

    // === Step 1: no secret grant — the plugin never sees the key, reports
    // no chains, and no endpoint surfaces. ===
    const denied = await service.getEndpoints(1);
    expect(denied).toEqual([]);

    // === Step 2: grant `secrets: ['api-key']` via the real TrustManager and
    // invalidate the (cached-empty) provider result. Exactly ONE endpoint
    // must surface for chain 1: the fixture's well-formed entry, with a
    // synthetic id, source 'plugin', and the key embedded in the url. The
    // deliberately malformed sibling entries (chainId 999 with a non-url,
    // chainId -5) must be dropped by core-side validation. ===
    await TrustManager.getInstance().setTrust(PLUGIN_ID, 'trusted', {
      repoWrite: false,
      net: false,
      secrets: ['api-key'],
    });
    service.invalidate();

    const granted = await service.getEndpoints(1);
    expect(granted).toHaveLength(1);
    expect(granted[0]).toEqual({
      id: `plugin:${PLUGIN_ID}:1:0`,
      url: SECRET_URL,
      label: 'Fixture',
      source: 'plugin',
      pluginId: PLUGIN_ID,
    });

    // The chainId-999 entry carried an invalid url, so core dropped it:
    // nothing surfaces for that chain (served from the same cached batch —
    // no refetch, the fixture's invalid entries are simply gone).
    expect(await service.getEndpoints(999)).toEqual([]);
    // And the non-positive chainId entry is gone too.
    expect(await service.getEndpoints(-5)).toEqual([]);

    // === Step 3: leak check — the key (and thus the key-embedding url)
    // appears in NEITHER captured non-result job-log output NOR any core log
    // line. The fixture only ever prints the sentinel-framed RESULT block,
    // which createSentinelLogFilter strips from onOutput; and
    // RpcProviderService never logs endpoint urls. ===
    const jobLogBlob = jobLogLines.join('\n');
    expect(jobLogBlob).not.toContain(API_KEY_VALUE);
    const coreLogBlob = coreLogLines.join('\n');
    expect(coreLogBlob).not.toContain(API_KEY_VALUE);
  }, 240_000);
});
