// End-to-end proof that the locally-installed chainz plugin can expose its
// file-backed PrivateKey signer surface and send through Ignite's signer flow.
// The fixture uses only anvil's public dev key #5.
import { describe, it, expect, afterAll } from 'vitest';
import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createPublicClient, getAddress, http, parseEther } from 'viem';
import { FileSystem } from '../../filesystem/FileSystem.js';

const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-chainz-signer-e2e-')
);
FileSystem.getInstance(IGNITE_HOME);

const { PluginRegistryLoader } = await import(
  '../../assets/PluginRegistryLoader.js'
);
const { PluginInstaller } = await import(
  '../../plugins/install/PluginInstaller.js'
);
const { LocalFolderBuildBackend } = await import(
  '../../plugins/install/LocalFolderBuildBackend.js'
);
const { PluginExecutor } = await import(
  '../../plugins/containers/PluginExecutor.js'
);
const { PluginInvoker } = await import('../../plugins/invoke/PluginInvoker.js');
const { TrustManager } = await import('../../plugins/trust/TrustManager.js');
const { PluginConfigStore } = await import(
  '../../plugins/config/PluginConfigStore.js'
);
const { SignerProviderService } = await import(
  '../../signers/SignerProviderService.js'
);
const { TxService } = await import('../../tx/TxService.js');
const { PluginType } = await import('@ignite/plugin-types/types');

const docker = new Docker();
const CHAINZ_PLUGIN_ID = 'chainz';
const CHAINZ_CONFIG_KEY = 'chainz-config';
const CHAINZ_REPO = path.resolve(
  __dirname,
  '../../../../../ignite-chainz-plugin'
);
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const ANVIL_CHAIN_ID = 31337;
const SEND_VALUE = parseEther('0.2');
const ANVIL_PRIVATE_KEY_5 =
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const ANVIL_ADDRESS_5 = getAddress(
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'
);
const ANVIL_ADDRESS_7 = getAddress(
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'
);

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function dockerReady(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

const skipReason = !(await directoryExists(CHAINZ_REPO))
  ? `chainz signer integration skipped: sibling repo not found at ${CHAINZ_REPO}`
  : !(await dockerReady())
    ? 'chainz signer integration skipped: Docker is unavailable'
    : undefined;

if (skipReason) {
  console.warn(skipReason);
}

describe('chainz local-install signer provider (Docker)', () => {
  const installer = new PluginInstaller(new LocalFolderBuildBackend());
  let anvilContainer: Docker.Container | undefined;
  let fixtureDir: string | undefined;

  afterAll(async () => {
    try {
      await installer.uninstall(CHAINZ_PLUGIN_ID);
    } catch {
      /* best effort */
    }
    if (anvilContainer) {
      await anvilContainer.stop({ t: 2 }).catch(() => {});
    }
    if (fixtureDir) {
      await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it.skipIf(Boolean(skipReason))(
    'installs chainz locally, lists its granted file-backed account, sends, then withholds config after grant downgrade',
    async () => {
      const meta = await installer.install({
        kind: 'local',
        contextDir: CHAINZ_REPO,
      });
      expect(meta.id).toBe(CHAINZ_PLUGIN_ID);
      expect(meta.types).toEqual([
        PluginType.RPC_PROVIDER,
        PluginType.SIGNER_PROVIDER,
      ]);

      const registry = PluginRegistryLoader.getInstance();
      const config = await registry.getPluginConfig(CHAINZ_PLUGIN_ID);
      expect(config.origin).toBe('installed');
      expect(config.metadata.types).toEqual([
        PluginType.RPC_PROVIDER,
        PluginType.SIGNER_PROVIDER,
      ]);
      await expect(
        registry.getPluginsByType(PluginType.SIGNER_PROVIDER)
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: 'installed',
            metadata: expect.objectContaining({
              id: CHAINZ_PLUGIN_ID,
              types: [PluginType.RPC_PROVIDER, PluginType.SIGNER_PROVIDER],
            }),
          }),
        ])
      );

      const anvil = await startAnvil();
      anvilContainer = anvil.container;
      const client = createPublicClient({ transport: http(anvil.rpcUrl) });
      const before = await client.getBalance({ address: ANVIL_ADDRESS_7 });

      fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chainz-config-'));
      const fixturePath = path.join(fixtureDir, 'chainz-fixture.json');
      await fs.writeFile(
        fixturePath,
        JSON.stringify(
          {
            chains: [
              {
                chain_id: ANVIL_CHAIN_ID,
                name: 'Anvil',
                selected_rpc: '${ANVIL_RPC_URL}',
              },
            ],
            variables: { ANVIL_RPC_URL: anvil.rpcUrl },
            keys: {
              'anvil-5': {
                name: 'anvil-5',
                type: 'PrivateKey',
                value: ANVIL_PRIVATE_KEY_5.slice(2),
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const configStore = new PluginConfigStore();
      await configStore.setValue(
        CHAINZ_PLUGIN_ID,
        CHAINZ_CONFIG_KEY,
        fixturePath
      );
      await TrustManager.getInstance().setTrust(CHAINZ_PLUGIN_ID, 'trusted', {
        repoWrite: false,
        net: false,
        secrets: [CHAINZ_CONFIG_KEY],
      });

      const executor = new PluginExecutor({
        pluginConfigStore: configStore,
        vaultStore: {
          getSecret: async () => undefined,
          listSecretKeys: async () => [],
        },
      });
      const invoker = new PluginInvoker({
        executeContainer: (pluginId, operation, options, opts) =>
          executor.execute(pluginId, operation, options, opts),
      });
      const service = new SignerProviderService({
        getProviders: async () => [
          {
            id: CHAINZ_PLUGIN_ID,
            name: 'chainz',
          },
        ],
        invoke: (pluginId, operation, params, opts) =>
          invoker.invoke(pluginId, operation, params, opts),
        txService: new TxService(),
        hasFrontendHost: () => false,
      });

      const accounts = await service.listAccounts(true);
      const chainzProvider = accounts.providers.find(
        (provider) => provider.pluginId === CHAINZ_PLUGIN_ID
      );
      expect(chainzProvider?.state).toBe('ok');
      expect(chainzProvider?.accounts).toContainEqual({
        id: 'anvil-5',
        address: ANVIL_ADDRESS_5,
        label: 'anvil-5',
        capability: 'sign-only',
      });

      const result = await service.send(
        {
          pluginId: CHAINZ_PLUGIN_ID,
          accountId: 'anvil-5',
          chainId: ANVIL_CHAIN_ID,
          rpcUrl: anvil.rpcUrl,
          chain: {
            name: 'Anvil',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          },
          to: ANVIL_ADDRESS_7,
          value: SEND_VALUE,
          data: '0x',
        },
        { log: () => {}, signal: new AbortController().signal }
      );

      expect(result.status).toBe('success');
      const after = await client.getBalance({ address: ANVIL_ADDRESS_7 });
      expect(after - before).toBe(SEND_VALUE);

      await TrustManager.getInstance().setTrust(CHAINZ_PLUGIN_ID, 'trusted', {
        repoWrite: false,
        net: false,
        secrets: [],
      });
      const downgraded = await service.listAccounts(true);
      const downgradedChainz = downgraded.providers.find(
        (provider) => provider.pluginId === CHAINZ_PLUGIN_ID
      );
      expect(downgradedChainz?.state).toBe('needs-config');
      expect(downgradedChainz?.accounts).toEqual([]);
    },
    300_000
  );
});

async function startAnvil(): Promise<{
  container: Docker.Container;
  rpcUrl: string;
}> {
  await ensureImage(ANVIL_IMAGE);

  const name = `ignite-anvil-${Date.now()}-${process.pid}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const container = await docker.createContainer({
    Image: ANVIL_IMAGE,
    name,
    Entrypoint: ['anvil'],
    Cmd: ['--host', '0.0.0.0'],
    ExposedPorts: { '8545/tcp': {} },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { '8545/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
    },
  });
  await container.start();

  const info = await container.inspect();
  const hostPort = info.NetworkSettings.Ports?.['8545/tcp']?.[0]?.HostPort;
  if (!hostPort) {
    throw new Error('Anvil container did not publish port 8545/tcp');
  }

  const rpcUrl = `http://127.0.0.1:${hostPort}`;
  await waitForChainId(rpcUrl);
  return { container, rpcUrl };
}

async function ensureImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // Pull below.
  }

  await new Promise<void>((resolve, reject) => {
    docker.pull(
      image,
      (pullError: Error | null, stream?: NodeJS.ReadableStream) => {
        if (pullError) {
          reject(pullError);
          return;
        }
        if (!stream) {
          reject(new Error(`Docker did not return a pull stream for ${image}`));
          return;
        }
        docker.modem.followProgress(stream, (progressError: Error | null) => {
          if (progressError) reject(progressError);
          else resolve();
        });
      }
    );
  });
}

async function waitForChainId(rpcUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const chainId = await rpc(rpcUrl, 'eth_chainId', []);
      if (chainId === `0x${ANVIL_CHAIN_ID.toString(16)}`) return;
      throw new Error(`Unexpected anvil chainId ${String(chainId)}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Timed out waiting for anvil eth_chainId at ${rpcUrl}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

async function rpc(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) {
    throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}
