import { describe, it, expect, afterAll } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import Docker from 'dockerode';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseEther,
  type Hex,
} from 'viem';
import type {
  DeploymentPlan,
  JobRecord,
  ListSignerAccountsData,
  RunRecord,
} from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';

const docker = new Docker();
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const ANVIL_CHAIN_ID = 31337;
const TOKEN = 'd'.repeat(64);
const BROWSER_WALLET_PLUGIN_ID = 'browser-wallet';
const ACCOUNT_ID = 'io.metamask:0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const ANVIL_ADDRESS_2 = getAddress(
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'
);
const ANVIL_ADDRESS_4 = getAddress(
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65'
);
const SEND_VALUE = parseEther('0.3');
const FOUNDRY_PLUGIN_ID = 'foundry';
const FOUNDRY_IMAGE = 'ignite/compiler_foundry:latest';
const DEPLOY_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'integration',
  'fixtures',
  'deploy-repo'
);

const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-frontend-runtime-e2e-')
);
FileSystem.getInstance(IGNITE_HOME);

const { registerSessionAuth } = await import('../../api/auth.js');
const { registerApi } = await import('../../api/index.js');
const { createWsHandler } = await import('../../api/ws.js');
const { setGlobalLogger } = await import('../../utils/logger.js');
const { JobManager } = await import('../../jobs/JobManager.js');
const { FrontendRuntimeBridge } = await import(
  '../../plugins/invoke/FrontendRuntimeBridge.js'
);
const { PluginInvoker } = await import('../../plugins/invoke/PluginInvoker.js');
const { SignerProviderService } = await import(
  '../../signers/SignerProviderService.js'
);
const { ChainRegistry } = await import('../../chains/ChainRegistry.js');
const { RpcStore } = await import('../../chains/RpcStore.js');
const { DeployEngine } = await import('../../deployments/DeployEngine.js');
const { PluginRegistryLoader } = await import(
  '../../assets/PluginRegistryLoader.js'
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

describe.skipIf(!ready)('frontend runtime fake host send loop (Docker)', () => {
  let anvilContainer: Docker.Container | undefined;
  let app: FastifyInstance | undefined;
  let ws: WebSocket | undefined;
  const fakeHostErrors: string[] = [];

  afterAll(async () => {
    ws?.close();
    await app?.close().catch(() => {});
    if (anvilContainer) {
      await anvilContainer.stop({ t: 2 }).catch(() => {});
    }
    await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('routes REST send through the WS bridge to a fake browser host and lands on anvil', async () => {
    FrontendRuntimeBridge.resetInstance();
    const anvil = await startAnvil();
    anvilContainer = anvil.container;
    const rpcEndpoint = await seedChainAndRpc(anvil.rpcUrl);
    app = await startApp();
    const baseUrl = getBaseUrl(app);

    const client = createPublicClient({ transport: http(anvil.rpcUrl) });
    const before = await client.getBalance({ address: ANVIL_ADDRESS_4 });

    const beforeHost = await listAccounts(baseUrl);
    const browserBefore = provider(beforeHost, BROWSER_WALLET_PLUGIN_ID);
    expect(browserBefore?.state).toBe('needs-browser');
    expect(browserBefore?.accounts).toEqual([]);

    ws = await connectFakeHost(baseUrl, anvil.rpcUrl, fakeHostErrors);
    const afterHost = await waitForBrowserWalletAccount(baseUrl);
    expect(afterHost.state).toBe('ok');
    expect(afterHost.accounts).toContainEqual({
      id: ACCOUNT_ID,
      address: ANVIL_ADDRESS_2,
      label: 'MetaMask 0x3C44...93BC',
      capability: 'sign-and-send',
    });

    const start = await httpJson<{ data: { job: JobRecord } }>(
      `${baseUrl}/api/v1/signers/send`,
      {
        method: 'POST',
        body: {
          pluginId: BROWSER_WALLET_PLUGIN_ID,
          accountId: ACCOUNT_ID,
          chainId: ANVIL_CHAIN_ID,
          rpcEndpointId: rpcEndpoint.id,
          to: ANVIL_ADDRESS_4,
          value: SEND_VALUE.toString(),
        },
      }
    );

    const job = await waitForJob(baseUrl, start.data.job.id);
    if (job.state !== 'succeeded') {
      throw new Error(
        `Send job failed: ${JSON.stringify(job.error)} fakeHostErrors=${JSON.stringify(
          fakeHostErrors
        )}`
      );
    }
    expect(job.state).toBe('succeeded');
    expect(job.result).toMatchObject({ status: 'success' });
    expect((job.result as { txHash?: unknown }).txHash).toMatch(
      /^0x[0-9a-fA-F]{64}$/
    );

    const after = await client.getBalance({ address: ANVIL_ADDRESS_4 });
    expect(after - before).toBe(SEND_VALUE);
  }, 240_000);

  it('recovers a disconnected browser-wallet deployment with its real mined hash', async () => {
    // Start a fresh app/bridge: the previous WS handler closes over its own
    // bridge instance, and this branch needs to simulate a disconnect.
    ws?.close();
    await app?.close().catch(() => {});
    await anvilContainer?.stop({ t: 2 }).catch(() => {});
    FrontendRuntimeBridge.resetInstance();
    // PluginInvoker captured the old bridge at construction and the signer
    // service captured that invoker's closure — reset both or runtime
    // requests route into the orphaned bridge.
    PluginInvoker.resetInstance();
    SignerProviderService.resetInstance();
    DeployEngine.resetInstance();

    const anvil = await startAnvil();
    anvilContainer = anvil.container;
    const rpcEndpoint = await seedChainAndRpc(anvil.rpcUrl);
    app = await startApp();
    const baseUrl = getBaseUrl(app);
    await assertFoundryReady();

    let releaseDisconnect!: () => void;
    const disconnectGate = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    let reportSubmitted!: (hash: Hex) => void;
    const submitted = new Promise<Hex>((resolve) => {
      reportSubmitted = resolve;
    });
    ws = await connectDisconnectingDeployHost(
      baseUrl,
      anvil.rpcUrl,
      reportSubmitted,
      disconnectGate
    );
    await waitForBrowserWalletAccount(baseUrl);

    const plan: DeploymentPlan = {
      schemaVersion: 1,
      contracts: [
        {
          id: 'token',
          repoPathOrUrl: DEPLOY_FIXTURE,
          frameworkId: FOUNDRY_PLUGIN_ID,
          artifactPath: 'out/Token.sol/Token.json',
          contractName: 'Token',
          sourcePath: 'src/Token.sol',
        },
      ],
      steps: [
        {
          id: 'deploy-token',
          kind: 'deploy',
          contractId: 'token',
          args: { name: 'Browser Token', symbol: 'BROW', supply: '1000' },
        },
      ],
      chains: [ANVIL_CHAIN_ID],
      signers: {
        global: {
          pluginId: BROWSER_WALLET_PLUGIN_ID,
          accountId: ACCOUNT_ID,
          address: ANVIL_ADDRESS_2,
        },
      },
    };
    const validation = await httpJson<{
      data: {
        chains: Record<
          string,
          Record<string, { ok: boolean; blocking: boolean }>
        >;
      };
    }>(`${baseUrl}/api/v1/deployments/validate`, {
      method: 'POST',
      body: { plan, rpcSelection: { [ANVIL_CHAIN_ID]: rpcEndpoint.id } },
    });
    for (const [itemKey, item] of Object.entries(
      validation.data.chains[String(ANVIL_CHAIN_ID)]
    )) {
      expect(
        !item.blocking || item.ok,
        `${itemKey} blocked: ${JSON.stringify(item)}`
      ).toBe(true);
    }

    const launched = await httpJson<{ data: { run: RunRecord } }>(
      `${baseUrl}/api/v1/deployments/runs`,
      {
        method: 'POST',
        body: {
          plan,
          rpcSelection: { [ANVIL_CHAIN_ID]: rpcEndpoint.id },
          idempotencyKey: crypto.randomUUID(),
        },
      }
    );
    const minedHash = await Promise.race([
      submitted,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Timed out waiting for fake wallet submission')),
          90_000
        )
      ),
    ]);
    const broadcasting = await waitForRun(
      baseUrl,
      launched.data.run.id,
      (run) =>
        run.lanes[String(ANVIL_CHAIN_ID)]?.steps[0]?.status === 'broadcasting'
    );
    expect(minedHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(
      broadcasting.lanes[String(ANVIL_CHAIN_ID)].steps[0].attempts[0].txHash
    ).toBeUndefined();

    // Release the fake tab to disconnect, then stop core while its
    // sign-and-send request is still in flight. No hash was durably returned.
    releaseDisconnect();
    const engine = DeployEngine.getInstance();
    await engine.shutdown();

    // A wallet may reconnect after the interruption. The engine uses the
    // refreshed account capability during startup recovery to decide that an
    // in-flight sign-and-send request needs explicit operator review.
    ws = await connectFakeHost(baseUrl, anvil.rpcUrl, fakeHostErrors);
    await waitForBrowserWalletAccount(baseUrl);

    // Sign-and-send does not expose a durable raw transaction. Startup
    // recovery upgrades the interrupted submission to needs-review, after
    // which the operator can attach the hash the browser actually mined.
    await engine.recoverOnStartup();
    const review = await waitForRun(
      baseUrl,
      launched.data.run.id,
      (run) =>
        run.lanes[String(ANVIL_CHAIN_ID)]?.pause?.reason === 'needs-review'
    );
    const attempt = review.lanes[String(ANVIL_CHAIN_ID)].steps[0].attempts[0];
    const resolved = await httpJson<{ data: { run: RunRecord } }>(
      `${baseUrl}/api/v1/deployments/runs/${launched.data.run.id}/lanes/${ANVIL_CHAIN_ID}/resolve`,
      {
        method: 'POST',
        body: {
          action: 'confirm-hash',
          attemptId: attempt.id,
          commandId: crypto.randomUUID(),
          txHash: minedHash,
        },
      }
    );
    expect(
      resolved.data.run.lanes[String(ANVIL_CHAIN_ID)].steps[0]
    ).toMatchObject({
      status: 'confirmed',
      attempts: [{ txHash: minedHash, txStatus: 'success' }],
    });
    expect(resolved.data.run.status).toBe('completed');
  }, 300_000);
});

async function startApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });
  setGlobalLogger(app.log);
  await registerSessionAuth(app, TOKEN);
  await JobManager.getInstance().recover();
  await app.register(websocket);
  await app.register(async function registerRuntimeWs(fastifyInstance) {
    fastifyInstance.get(
      '/ws',
      { websocket: true },
      createWsHandler(
        JobManager.getInstance(),
        FrontendRuntimeBridge.getInstance()
      )
    );
  });
  await registerApi(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

function getBaseUrl(app: FastifyInstance): string {
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fastify did not bind to a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function seedChainAndRpc(rpcUrl: string) {
  await new ChainRegistry().upsertCustomChain({
    chainId: ANVIL_CHAIN_ID,
    name: 'Anvil',
    shortName: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [],
  });
  return new RpcStore().add(ANVIL_CHAIN_ID, {
    url: rpcUrl,
    label: 'Anvil',
  });
}

async function connectFakeHost(
  baseUrl: string,
  rpcUrl: string,
  fakeHostErrors: string[]
): Promise<WebSocket> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl, { headers: { 'x-ignite-token': TOKEN } });
  ws.on('message', (raw) => {
    void handleFakeHostFrame(ws, rpcUrl, raw).catch((error) => {
      const parsed = parseFrame(raw);
      if (parsed?.type !== 'runtime-request') return;
      fakeHostErrors.push(
        error instanceof Error ? error.message : String(error)
      );
      ws.send(
        JSON.stringify({
          type: 'runtime-response',
          requestId: parsed.requestId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'runtime-register',
      pluginIds: [BROWSER_WALLET_PLUGIN_ID],
    })
  );
  return ws;
}

async function handleFakeHostFrame(
  ws: WebSocket,
  rpcUrl: string,
  raw: WebSocket.RawData
): Promise<void> {
  const frame = parseFrame(raw);
  if (frame?.type !== 'runtime-request') return;

  if (frame.operation === 'getAccounts') {
    ws.send(
      JSON.stringify({
        type: 'runtime-response',
        requestId: frame.requestId,
        result: {
          success: true,
          data: {
            accounts: [
              {
                id: ACCOUNT_ID,
                address: ANVIL_ADDRESS_2,
                label: 'MetaMask 0x3C44...93BC',
                capability: 'sign-and-send',
              },
            ],
          },
        },
      })
    );
    return;
  }

  if (frame.operation === 'sendTransaction') {
    const params = frame.params as {
      tx: { to: Hex | null; value: Hex; data: Hex; gas: Hex };
    };
    const chain = defineChain({
      id: ANVIL_CHAIN_ID,
      name: 'Anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const wallet = createWalletClient({
      account: ANVIL_ADDRESS_2,
      chain,
      transport: http(rpcUrl),
    });
    const txHash = await wallet.sendTransaction({
      to: params.tx.to ?? undefined,
      value: BigInt(params.tx.value),
      data: params.tx.data,
      gas: BigInt(params.tx.gas),
    });
    ws.send(
      JSON.stringify({
        type: 'runtime-response',
        requestId: frame.requestId,
        result: { success: true, data: { txHash } },
      })
    );
  }
}

async function connectDisconnectingDeployHost(
  baseUrl: string,
  rpcUrl: string,
  onSubmitted: (hash: Hex) => void,
  disconnectGate: Promise<void>
): Promise<WebSocket> {
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl, { headers: { 'x-ignite-token': TOKEN } });
  ws.on('message', (raw) => {
    void (async () => {
      const frame = parseFrame(raw);
      if (frame?.type !== 'runtime-request') return;
      if (frame.operation === 'getAccounts') {
        ws.send(
          JSON.stringify({
            type: 'runtime-response',
            requestId: frame.requestId,
            result: {
              success: true,
              data: {
                accounts: [
                  {
                    id: ACCOUNT_ID,
                    address: ANVIL_ADDRESS_2,
                    label: 'MetaMask 0x3C44...93BC',
                    capability: 'sign-and-send',
                  },
                ],
              },
            },
          })
        );
        return;
      }
      if (frame.operation !== 'sendTransaction') return;
      const params = frame.params as {
        tx: { to: Hex | null; value: Hex; data: Hex; gas: Hex };
      };
      const chain = defineChain({
        id: ANVIL_CHAIN_ID,
        name: 'Anvil',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
      const wallet = createWalletClient({
        account: ANVIL_ADDRESS_2,
        chain,
        transport: http(rpcUrl),
      });
      const txHash = await wallet.sendTransaction({
        to: params.tx.to ?? undefined,
        value: BigInt(params.tx.value),
        data: params.tx.data,
        gas: BigInt(params.tx.gas),
      });
      await createPublicClient({
        transport: http(rpcUrl),
      }).waitForTransactionReceipt({
        hash: txHash,
      });
      onSubmitted(txHash);
      await disconnectGate;
      // Deliberately omit runtime-response: the real wallet has broadcast,
      // but core cannot know its hash after the browser tab disappears.
      ws.close();
    })().catch(() => ws.close());
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'runtime-register',
      pluginIds: [BROWSER_WALLET_PLUGIN_ID],
    })
  );
  return ws;
}

async function assertFoundryReady(): Promise<void> {
  const config =
    await PluginRegistryLoader.getInstance().getPluginConfig(FOUNDRY_PLUGIN_ID);
  expect(config.origin).toBe('builtin');
  expect(config.metadata.baseImage).toBe(FOUNDRY_IMAGE);
  try {
    await docker.getImage(FOUNDRY_IMAGE).inspect();
  } catch (error) {
    throw new Error(
      `Built-in foundry image ${FOUNDRY_IMAGE} is not available. Run \`cd plugins && npm run build\` before this integration test. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function waitForRun(
  baseUrl: string,
  runId: string,
  predicate: (run: RunRecord) => boolean
): Promise<RunRecord> {
  const deadline = Date.now() + 90_000;
  let last: RunRecord | undefined;
  while (Date.now() < deadline) {
    const response = await httpJson<{ data: { run: RunRecord } }>(
      `${baseUrl}/api/v1/deployments/runs/${runId}`
    );
    last = response.data.run;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for deployment run: ${JSON.stringify(last)}`
  );
}

function parseFrame(raw: WebSocket.RawData):
  | {
      type: string;
      requestId?: string;
      operation?: string;
      params?: unknown;
    }
  | undefined {
  try {
    return JSON.parse(raw.toString()) as {
      type: string;
      requestId?: string;
      operation?: string;
      params?: unknown;
    };
  } catch {
    return undefined;
  }
}

async function listAccounts(baseUrl: string): Promise<ListSignerAccountsData> {
  const response = await httpJson<{ data: ListSignerAccountsData }>(
    `${baseUrl}/api/v1/signers/accounts?refresh=true`
  );
  return response.data;
}

function provider(data: ListSignerAccountsData, pluginId: string) {
  return data.providers.find((entry) => entry.pluginId === pluginId);
}

async function waitForBrowserWalletAccount(baseUrl: string) {
  const deadline = Date.now() + 20_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const data = await listAccounts(baseUrl);
    const entry = provider(data, BROWSER_WALLET_PLUGIN_ID);
    if (entry?.state === 'ok' && entry.accounts.length > 0) return entry;
    last = entry;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Timed out waiting for browser-wallet account: ${JSON.stringify(last)}`
  );
}

async function waitForJob(baseUrl: string, jobId: string): Promise<JobRecord> {
  const deadline = Date.now() + 60_000;
  let last: JobRecord | undefined;
  while (Date.now() < deadline) {
    const response = await httpJson<{ data: { job: JobRecord } }>(
      `${baseUrl}/api/v1/jobs/${jobId}`
    );
    last = response.data.job;
    if (
      last.state === 'succeeded' ||
      last.state === 'failed' ||
      last.state === 'cancelled'
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for job ${jobId}: ${JSON.stringify(last)}`
  );
}

async function httpJson<T>(
  url: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-ignite-token': TOKEN,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
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
