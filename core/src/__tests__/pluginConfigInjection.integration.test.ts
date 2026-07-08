// End-to-end proof of the config/vault/secrets injection feature (D1b): a
// third-party plugin declares a plain field, a secret field, and a
// perChain+secret field; this test installs it through the REAL
// PluginInstaller, sets values through the REAL PluginConfigStore/VaultStore
// (vault keyed by a fake in-memory master key — never the OS keychain), and
// drives echoConfig through the REAL PluginExecutor + Docker to prove:
//   1. an untrusted grant never resolves any secret field
//   2. a `secrets: ['api-key']` grant resolves exactly that key, verbatim,
//      and nothing else (rpc-url stays withheld)
//   3. the secret never appears in the created container's Config (Env/Cmd)
//   4. the secret never appears in non-result job-log output — it only ever
//      travels inside the sentinel-framed RESULT block (the legitimate
//      channel), never as plain job-log text.
//
// This is the security-critical proof for the whole feature; see
// resolveConfig.ts and PluginExecutor.resolvePluginConfig for the production
// code this exercises.
import { describe, it, expect, afterAll } from 'vitest';
import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FileSystem } from '../filesystem/FileSystem.js';

// Sandbox the ignite home BEFORE any singleton resolves it (see
// thirdparty-plugin.integration.test.ts) so nothing here ever touches the
// developer's real ~/.ignite — including trust.json, plugin-config.json, and
// vault.json.
const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-config-e2e-')
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
const { PluginConfigStore } = await import(
  '../plugins/config/PluginConfigStore.js'
);
const { ContainerOrchestrator } = await import(
  '../plugins/containers/ContainerOrchestrator.js'
);

const docker = new Docker();
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'config-fixture'
);
const PLUGIN_ID = 'config-fixture';
const ENDPOINT_VALUE = 'https://endpoint.example.com';
const API_KEY_VALUE = 'sk-super-secret-api-key-do-not-leak';
const RPC_URL_VALUE = 'https://rpc.example.com/1?key=also-secret';
const CHAIN_ID = 1;

async function dockerReady(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}
const ready = await dockerReady();

describe.skipIf(!ready)('plugin config/vault/secrets injection (Docker)', () => {
  const installer = new PluginInstaller(new LocalFolderBuildBackend());
  let workspace: string | undefined;

  afterAll(async () => {
    try {
      await installer.uninstall(PLUGIN_ID);
    } catch {
      /* best effort */
    }
    if (workspace) {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('injects only granted values, leaking nothing to the container or logs', async () => {
    // --- Install the fixture through the real installer. ---
    const meta = await installer.install({
      kind: 'local',
      contextDir: FIXTURE,
      dockerfile: 'Dockerfile',
    });
    expect(meta.id).toBe(PLUGIN_ID);
    expect(meta.configFields?.map((f) => f.key)).toEqual([
      'endpoint',
      'api-key',
      'rpc-url',
    ]);

    // echoConfig has no permission requirement, but the fixture is a
    // 'compiler' type plugin, which always requiresRepo — bind-mount a
    // throwaway host workspace so execute() doesn't reject for a missing one.
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'config-fixture-ws-'));

    // --- Populate the REAL stores (scoped to IGNITE_HOME above). ---
    const configStore = new PluginConfigStore();
    await configStore.setValue(PLUGIN_ID, 'endpoint', ENDPOINT_VALUE);

    // Fake master key: fixed 32-byte buffer, never the OS keychain. This is
    // the ONLY VaultStore instance the executor under test ever sees.
    const fakeMasterKey = Buffer.alloc(32, 7);
    const vaultStore = new VaultStore({
      getMasterKey: async () => fakeMasterKey,
    });
    await vaultStore.setSecret(PLUGIN_ID, 'api-key', API_KEY_VALUE);
    await vaultStore.setSecret(PLUGIN_ID, 'rpc-url', RPC_URL_VALUE, CHAIN_ID);

    // --- Orchestrator spy: captures the created container's own Config
    // (Env/Cmd) before PluginExecutor stops it (AutoRemove would otherwise
    // remove it before this test could inspect it). Delegates to the real
    // ContainerOrchestrator singleton for everything else, so the actual
    // Docker container creation/removal path under test is untouched. ---
    const realOrchestrator = ContainerOrchestrator.getInstance();
    let lastContainerConfig: { Env?: string[]; Cmd?: string[] } | undefined;
    const orchestratorSpy = {
      createContainer: async (opts: Parameters<
        typeof realOrchestrator.createContainer
      >[0]) => {
        const name = await realOrchestrator.createContainer(opts);
        const info = await docker.getContainer(name).inspect();
        lastContainerConfig = info.Config;
        return name;
      },
      stopContainer: (name: string) => realOrchestrator.stopContainer(name),
      getContainer: (name: string) => realOrchestrator.getContainer(name),
      cleanup: () => realOrchestrator.cleanup(),
      cleanupDetached: () => realOrchestrator.cleanupDetached(),
    };

    const executor = new PluginExecutor({
      vaultStore,
      containerOrchestrator: orchestratorSpy,
    });

    // === Step 1: untrusted (no grant at all) — only the non-secret field
    // resolves. Neither secret field is ever fetched from the vault. ===
    const denied = await executor.execute(
      PLUGIN_ID,
      'echoConfig',
      {},
      { workspacePath: workspace }
    );
    expect(denied.success).toBe(true);
    if (denied.success) {
      const received = (denied.data as { received: Record<string, unknown> })
        .received;
      expect(received).toEqual({ endpoint: ENDPOINT_VALUE });
      expect(received).not.toHaveProperty('api-key');
      expect(received).not.toHaveProperty('rpc-url');
    }

    // === Step 2: grant `secrets: ['api-key']` via the real TrustManager. ===
    await TrustManager.getInstance().setTrust(PLUGIN_ID, 'trusted', {
      repoWrite: false,
      net: false,
      secrets: ['api-key'],
    });

    const jobLogLines: string[] = [];
    const granted = await executor.execute(
      PLUGIN_ID,
      'echoConfig',
      {},
      {
        workspacePath: workspace,
        onOutput: (text) => jobLogLines.push(text),
      }
    );
    expect(granted.success).toBe(true);
    if (granted.success) {
      const received = (granted.data as { received: Record<string, unknown> })
        .received;
      expect(received.endpoint).toBe(ENDPOINT_VALUE);
      // Exact value, verbatim — the granted secret round-trips unmodified.
      expect(received['api-key']).toBe(API_KEY_VALUE);
      // rpc-url was never granted, so it stays withheld even though a value
      // is stored in the vault for it.
      expect(received).not.toHaveProperty('rpc-url');
    }

    // === Step 3: container hygiene — the secret appears in NEITHER Env NOR
    // Cmd/argv of the container Docker actually created. Config values
    // travel exclusively over the stdin-attached exec, never container
    // creation options. ===
    expect(lastContainerConfig).toBeDefined();
    const envBlob = JSON.stringify(lastContainerConfig?.Env ?? []);
    const cmdBlob = JSON.stringify(lastContainerConfig?.Cmd ?? []);
    expect(envBlob).not.toContain(API_KEY_VALUE);
    expect(envBlob).not.toContain(RPC_URL_VALUE);
    expect(cmdBlob).not.toContain(API_KEY_VALUE);
    expect(cmdBlob).not.toContain(RPC_URL_VALUE);

    // === Step 4: log hygiene — the secret is absent from every non-result
    // job-log line. The fixture only ever prints the sentinel-framed RESULT
    // block (the legitimate channel for the granted value to reach the
    // caller), so createSentinelLogFilter suppresses it entirely from
    // onOutput; asserting on the accumulated job log proves the secret never
    // rode along on a bare/unframed log line. ===
    const jobLogBlob = jobLogLines.join('\n');
    expect(jobLogBlob).not.toContain(API_KEY_VALUE);
    expect(jobLogBlob).not.toContain(RPC_URL_VALUE);
  }, 240_000);
});
