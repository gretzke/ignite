// Exercises the REAL container path for the private-key plugin: ephemeral
// container, stdin config injection, framed stdout — then core-side
// verification and broadcast against a disposable anvil container.
// Skipped when Docker is unavailable (same guard as the other integration tests).
import { describe, it, expect, afterAll } from 'vitest';
import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createPublicClient, getAddress, http, parseEther } from 'viem';
import { FileSystem } from '../../filesystem/FileSystem.js';

// Sandbox the ignite home BEFORE any singleton resolves it so nothing here
// touches the developer's real ~/.ignite (trust.json, vault.json,
// plugin-config.json, installed-plugin registry).
const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-signer-send-e2e-')
);
FileSystem.getInstance(IGNITE_HOME);

const { PluginRegistryLoader } = await import(
  '../../assets/PluginRegistryLoader.js'
);
const { PluginExecutor } = await import(
  '../../plugins/containers/PluginExecutor.js'
);
const { PluginInvoker } = await import('../../plugins/invoke/PluginInvoker.js');
const { VaultStore } = await import('../../plugins/vault/VaultStore.js');
const { PluginConfigStore } = await import(
  '../../plugins/config/PluginConfigStore.js'
);
const { SignerProviderService } = await import(
  '../../signers/SignerProviderService.js'
);
const { TxService } = await import('../../tx/TxService.js');
const { PluginType } = await import('@ignite/plugin-types/types');

const docker = new Docker();
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const PRIVATE_KEY_PLUGIN_ID = 'private-key';
const PRIVATE_KEY_IMAGE = 'ignite/signer-provider_private-key:latest';
const LIST_ITEM_ID = 'anvl0001';
const ANVIL_CHAIN_ID = 31337;
const ONE_ETHER = parseEther('1');

const ANVIL_PRIVATE_KEY_0 =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_ADDRESS_0 = getAddress(
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
);
const ANVIL_ADDRESS_1 = getAddress(
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
);

async function dockerReady(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}
const ready = await dockerReady();

describe.skipIf(!ready)(
  'signer send private-key container path (Docker)',
  () => {
    let anvilContainer: Docker.Container | undefined;

    afterAll(async () => {
      if (anvilContainer) {
        await anvilContainer.stop({ t: 2 }).catch(() => {});
      }
      await fs
        .rm(IGNITE_HOME, { recursive: true, force: true })
        .catch(() => {});
    });

    it('lists the injected anvil account and sends one ether through sign-verify-broadcast', async () => {
      await assertBuiltinPrivateKeyReady();

      const anvil = await startAnvil();
      anvilContainer = anvil.container;
      const client = createPublicClient({ transport: http(anvil.rpcUrl) });

      const before = await client.getBalance({ address: ANVIL_ADDRESS_1 });

      const fakeMasterKey = Buffer.alloc(32, 12);
      const vaultStore = new VaultStore({
        getMasterKey: async () => fakeMasterKey,
      });
      const configStore = new PluginConfigStore();
      await configStore.setValue(PRIVATE_KEY_PLUGIN_ID, 'keys', [
        { id: LIST_ITEM_ID, values: { label: 'Anvil #0' } },
      ]);
      await vaultStore.setSecret(
        PRIVATE_KEY_PLUGIN_ID,
        `keys.${LIST_ITEM_ID}.privateKey`,
        ANVIL_PRIVATE_KEY_0
      );

      const executor = new PluginExecutor({ vaultStore });
      const invoker = new PluginInvoker({
        executeContainer: (pluginId, operation, options, opts) =>
          executor.execute(pluginId, operation, options, opts),
      });
      const service = new SignerProviderService({
        invoke: (pluginId, operation, params, opts) =>
          invoker.invoke(pluginId, operation, params, opts),
        txService: new TxService(),
      });

      const accounts = await service.listAccounts(true);
      const privateKeyProvider = accounts.providers.find(
        (provider) => provider.pluginId === PRIVATE_KEY_PLUGIN_ID
      );
      expect(privateKeyProvider?.state).toBe('ok');
      expect(privateKeyProvider?.accounts).toContainEqual({
        id: LIST_ITEM_ID,
        address: ANVIL_ADDRESS_0,
        label: 'Anvil #0',
        capability: 'sign-only',
      });

      const result = await service.send(
        {
          pluginId: PRIVATE_KEY_PLUGIN_ID,
          accountId: LIST_ITEM_ID,
          chainId: ANVIL_CHAIN_ID,
          rpcUrl: anvil.rpcUrl,
          chain: {
            name: 'Anvil',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          },
          to: ANVIL_ADDRESS_1,
          value: ONE_ETHER,
          data: '0x',
        },
        { log: () => {}, signal: new AbortController().signal }
      );

      expect(result.status).toBe('success');
      const after = await client.getBalance({ address: ANVIL_ADDRESS_1 });
      expect(after - before).toBe(ONE_ETHER);
    }, 240_000);
  }
);

async function assertBuiltinPrivateKeyReady(): Promise<void> {
  let config;
  try {
    config = await PluginRegistryLoader.getInstance().getPluginConfig(
      PRIVATE_KEY_PLUGIN_ID
    );
  } catch (error) {
    throw new Error(
      `Built-in plugin registry does not contain ${PRIVATE_KEY_PLUGIN_ID}. ` +
        'Run `cd plugins && npm run build` before this integration test. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  expect(config.origin).toBe('builtin');
  expect(config.metadata.types).toContain(PluginType.SIGNER_PROVIDER);
  expect(config.metadata.baseImage).toBe(PRIVATE_KEY_IMAGE);

  try {
    await docker.getImage(PRIVATE_KEY_IMAGE).inspect();
  } catch (error) {
    throw new Error(
      `Built-in private-key image ${PRIVATE_KEY_IMAGE} is not available. ` +
        'Run `cd plugins && npm run build` before this integration test. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

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
    // The current ghcr.io/foundry-rs/foundry:latest image has /bin/sh -c as
    // its entrypoint; set anvil explicitly so argv is interpreted correctly.
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
