// Docker/anvil proof for the deployment REST surface. The fixture is already
// compiled: this suite deliberately never invokes forge.
import { afterAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import fastify, { type FastifyInstance } from 'fastify';
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
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  DeploymentArtifact,
  DeploymentPlan,
  RunRecord,
} from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';

const docker = new Docker();
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const PRIVATE_KEY_PLUGIN_ID = 'private-key';
const PRIVATE_KEY_IMAGE = 'ignite/signer-provider_private-key:latest';
const FOUNDRY_PLUGIN_ID = 'foundry';
const FOUNDRY_IMAGE = 'ignite/compiler_foundry:latest';
const ANVIL_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ANVIL_ADDRESS = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const NONCE_CONSUMER = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const CHAIN_A = 31337;
const CHAIN_B = 31338;
const TOKEN = 'd'.repeat(64);
const KEY_ITEM_ID = 'anvildeploy1';
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'deploy-repo'
);

// Set this before imports that may resolve a FileSystem singleton.
const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-deploy-e2e-')
);
FileSystem.getInstance(IGNITE_HOME);

const { registerSessionAuth } = await import('../../api/auth.js');
const { createDeploymentHandlers } = await import('../../api/deployments.js');
const { ChainRegistry } = await import('../../chains/ChainRegistry.js');
const { RpcStore } = await import('../../chains/RpcStore.js');
const { DeployEngine } = await import('../../deployments/DeployEngine.js');
const { validatePlan } = await import('../../deployments/validation.js');
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
const { ProfileManager } = await import('../../filesystem/ProfileManager.js');

type Engine = InstanceType<typeof DeployEngine>;
type Anvil = { container: Docker.Container; rpcUrl: string; chainId: number };

async function dockerReady(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}
const ready = await dockerReady();

describe.skipIf(!ready)('deployRun: two anvil containers (Docker)', () => {
  let app: FastifyInstance | undefined;
  let anvilA: Anvil | undefined;
  let anvilB: Anvil | undefined;
  let activeEngine: Engine | undefined;

  afterAll(async () => {
    await activeEngine?.shutdown().catch(() => {});
    await app?.close().catch(() => {});
    for (const anvil of [anvilA, anvilB]) {
      await anvil?.container.stop({ t: 2 }).catch(() => {});
    }
    await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('validates, deploys, renders artifacts, handles a revert, and recovers after shutdown', async () => {
    await assertBuiltinImages();
    const signerService = await configurePrivateKeySigner();
    anvilA = await startAnvil(CHAIN_A);
    anvilB = await startAnvil(CHAIN_B);

    const endpoints = await seedChainsAndRpc(anvilA, anvilB);
    // Separate anvil instances otherwise derive the same CREATE address for
    // the same account + nonce. Consume one chain-B nonce to prove each lane
    // reports its own actual contract address.
    await consumeNonce(anvilB);

    const makeEngine = (): Engine =>
      new DeployEngine({
        executeTx: signerService.executeTx.bind(signerService),
        resolveAccount: signerService.resolveAccount.bind(signerService),
        validate: (plan, selection, opts) =>
          validatePlan(plan, selection, {
            profileId: opts?.profileId,
            listAccounts: async () =>
              (await signerService.listAccounts(true)).providers,
          }),
        chainMetadata: async (chainId) => ({
          name: `Anvil ${chainId}`,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        }),
      });
    activeEngine = makeEngine();
    app = await startDeploymentApp(() => activeEngine!);
    const baseUrl = getBaseUrl(app);

    const plan = makePlan([CHAIN_A, CHAIN_B]);
    const rpcSelection = {
      [CHAIN_A]: endpoints[CHAIN_A].id,
      [CHAIN_B]: endpoints[CHAIN_B].id,
    };
    const validation = await httpJson<{
      data: {
        chains: Record<
          string,
          Record<string, { ok: boolean; blocking: boolean; message: string }>
        >;
      };
    }>(`${baseUrl}/api/v1/deployments/validate`, {
      method: 'POST',
      body: { plan, rpcSelection },
    });
    // Non-blocking annotations (e.g. stale block, dirty worktree) may be
    // ok:false by design; the launch gate is blocking items only.
    for (const [chainKey, checklist] of Object.entries(
      validation.data.chains
    )) {
      for (const [itemKey, item] of Object.entries(checklist)) {
        expect(
          !item.blocking || item.ok,
          `chain ${chainKey} ${itemKey} blocked: ${JSON.stringify(item)}`
        ).toBe(true);
      }
    }

    const launched = await createRun(
      baseUrl,
      plan,
      rpcSelection,
      'two-anvil-happy'
    );
    const complete = await waitForRun(
      baseUrl,
      launched.id,
      (run) => run.status === 'completed'
    );
    expect(complete.status).toBe('completed');
    const addresses = [CHAIN_A, CHAIN_B].map((chainId) => {
      const lane = complete.lanes[String(chainId)];
      expect(lane.status).toBe('completed');
      const address = lane.steps[0].address;
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      return address as Hex;
    });
    expect(addresses[0]).not.toBe(addresses[1]);
    for (const [anvil, address] of [
      [anvilA, addresses[0]],
      [anvilB, addresses[1]],
    ] as const) {
      const code = await createPublicClient({
        transport: http(anvil.rpcUrl),
      }).getCode({ address });
      expect(code).not.toBe('0x');
    }

    const artifactResponse = await httpJson<{
      data: { artifact: DeploymentArtifact };
    }>(`${baseUrl}/api/v1/deployments/runs/${launched.id}/artifact`);
    const artifact = artifactResponse.data.artifact;
    expect(artifact).toMatchObject({
      schemaVersion: 2,
      runId: launched.id,
      status: 'completed',
      contracts: [
        {
          repoName: 'deploy-repo',
          sourcePath: 'src/Token.sol',
          contractName: 'Token',
        },
      ],
    });
    expect(artifact.validation.chains[String(CHAIN_A)]).toBeDefined();
    for (const [chainId, address] of [
      [CHAIN_A, addresses[0]],
      [CHAIN_B, addresses[1]],
    ] as const) {
      const runStep = complete.lanes[String(chainId)].steps[0];
      const artifactStep = artifact.lanes[String(chainId)].steps[0];
      expect(artifactStep).toMatchObject({
        stepId: 'deploy-token',
        status: 'confirmed',
        address,
        args: { name: 'Ignite Token', symbol: 'IGN', supply: '1000000' },
      });
      expect(artifactStep.attempts).toHaveLength(1);
      expect(artifactStep.attempts[0]).toMatchObject({
        txHash: runStep.attempts[0].txHash,
        blockNumber: runStep.attempts[0].blockNumber,
        gasUsed: runStep.attempts[0].gasUsed,
        effectiveGasPrice: runStep.attempts[0].effectiveGasPrice,
        txStatus: 'success',
      });
    }
    const serializedArtifact = JSON.stringify(artifact);
    expect(serializedArtifact).not.toContain('http');
    expect(serializedArtifact).not.toContain('/Users/');
    expect(serializedArtifact).not.toContain(IGNITE_HOME);

    const outOfGasPlan = makePlan([CHAIN_B], {
      // Stay above intrinsic deployment gas so anvil mines a failed receipt,
      // while remaining far below the constructor's successful estimate.
      gasOverridesPerChain: { [CHAIN_B]: { gasLimit: '300000' } },
    });
    const outOfGasSelection = { [CHAIN_B]: endpoints[CHAIN_B].id };
    const greenOverride = await httpJson<{
      data: { chains: Record<string, Record<string, { ok: boolean }>> };
    }>(`${baseUrl}/api/v1/deployments/validate`, {
      method: 'POST',
      body: { plan: outOfGasPlan, rpcSelection: outOfGasSelection },
    });
    expect(
      Object.values(greenOverride.data.chains[String(CHAIN_B)]).every(
        (item) => item.ok
      )
    ).toBe(true);

    const skippedRun = await createRun(
      baseUrl,
      outOfGasPlan,
      outOfGasSelection,
      'out-of-gas-skip'
    );
    const pausedForSkip = await waitForRun(
      baseUrl,
      skippedRun.id,
      (run) => run.lanes[String(CHAIN_B)]?.pause?.reason === 'revert'
    );
    const failedAttempt =
      pausedForSkip.lanes[String(CHAIN_B)].steps[0].attempts[0];
    const revertedReceipt = await createPublicClient({
      transport: http(anvilB.rpcUrl),
    }).getTransactionReceipt({ hash: failedAttempt.txHash! });
    expect(revertedReceipt.status).toBe('reverted');
    await resolveLane(baseUrl, skippedRun.id, CHAIN_B, {
      action: 'skip',
      attemptId: failedAttempt.id,
      commandId: crypto.randomUUID(),
      note: 'expected out-of-gas integration branch',
    });
    const skipped = await waitForRun(
      baseUrl,
      skippedRun.id,
      (run) => run.status === 'completed'
    );
    expect(skipped.lanes[String(CHAIN_B)].steps[0].status).toBe('skipped');

    const abortedRun = await createRun(
      baseUrl,
      outOfGasPlan,
      outOfGasSelection,
      'out-of-gas-abort'
    );
    const pausedForAbort = await waitForRun(
      baseUrl,
      abortedRun.id,
      (run) => run.lanes[String(CHAIN_B)]?.pause?.reason === 'revert'
    );
    const abortedAttempt =
      pausedForAbort.lanes[String(CHAIN_B)].steps[0].attempts[0];
    const abortedResponse = await resolveLane(baseUrl, abortedRun.id, CHAIN_B, {
      action: 'abort-lane',
      attemptId: abortedAttempt.id,
      commandId: crypto.randomUUID(),
    });
    expect(abortedResponse.status).toBe('failed');
    expect(abortedResponse.lanes[String(CHAIN_B)].status).toBe('aborted');

    await setAutomine(anvilA, false);
    await setAutomine(anvilB, false);
    const recoveringRun = await createRun(
      baseUrl,
      plan,
      rpcSelection,
      'shutdown-recovery'
    );
    const inFlight = await waitForRun(baseUrl, recoveringRun.id, (run) =>
      [CHAIN_A, CHAIN_B].every(
        (chainId) =>
          run.lanes[String(chainId)]?.steps[0]?.status === 'broadcasting'
      )
    );
    expect(inFlight.lanes[String(CHAIN_A)].steps[0].attempts[0].txHash).toMatch(
      /^0x[0-9a-f]{64}$/
    );
    await activeEngine.shutdown();
    activeEngine = makeEngine();
    await activeEngine.recoverOnStartup();
    const interrupted = await waitForRun(baseUrl, recoveringRun.id, (run) =>
      [CHAIN_A, CHAIN_B].every(
        (chainId) => run.lanes[String(chainId)]?.pause?.reason === 'interrupted'
      )
    );
    expect(
      interrupted.lanes[String(CHAIN_A)].steps[0].attempts[0].txHash
    ).toMatch(/^0x[0-9a-f]{64}$/);
    await minePending(anvilA);
    await minePending(anvilB);
    await httpJson(
      `${baseUrl}/api/v1/deployments/runs/${recoveringRun.id}/resume`,
      { method: 'POST' }
    );
    const recovered = await waitForRun(
      baseUrl,
      recoveringRun.id,
      (run) => run.status === 'completed'
    );
    expect(recovered.lanes[String(CHAIN_A)].steps[0].status).toBe('confirmed');
  }, 360_000);
});

async function assertBuiltinImages(): Promise<void> {
  const registry = PluginRegistryLoader.getInstance();
  for (const [pluginId, image] of [
    [PRIVATE_KEY_PLUGIN_ID, PRIVATE_KEY_IMAGE],
    [FOUNDRY_PLUGIN_ID, FOUNDRY_IMAGE],
  ] as const) {
    const config = await registry.getPluginConfig(pluginId);
    expect(config.origin).toBe('builtin');
    expect(config.metadata.baseImage).toBe(image);
    try {
      await docker.getImage(image).inspect();
    } catch (error) {
      throw new Error(
        `Built-in image ${image} is unavailable. Run \`cd plugins && npm run build\` before this integration suite. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

async function configurePrivateKeySigner(): Promise<
  InstanceType<typeof SignerProviderService>
> {
  const vaultStore = new VaultStore({
    getMasterKey: async () => Buffer.alloc(32, 9),
  });
  const configStore = new PluginConfigStore();
  await configStore.setValue(PRIVATE_KEY_PLUGIN_ID, 'keys', [
    { id: KEY_ITEM_ID, values: { label: 'Anvil deployment account' } },
  ]);
  await vaultStore.setSecret(
    PRIVATE_KEY_PLUGIN_ID,
    `keys.${KEY_ITEM_ID}.private-key`,
    ANVIL_PRIVATE_KEY
  );
  const executor = new PluginExecutor({ vaultStore });
  const invoker = new PluginInvoker({
    executeContainer: (pluginId, operation, options, opts) =>
      executor.execute(pluginId, operation, options, opts),
  });
  return new SignerProviderService({
    invoke: (pluginId, operation, params, opts) =>
      invoker.invoke(pluginId, operation, params, opts),
  });
}

async function startDeploymentApp(
  getEngine: () => Engine
): Promise<FastifyInstance> {
  const profile = await ProfileManager.getInstance();
  const app = fastify({ logger: false });
  await registerSessionAuth(app, TOKEN);
  const handlers = () =>
    createDeploymentHandlers({
      engine: getEngine(),
      validate: (plan, rpc, opts) => getEngine().validatePlan(plan, rpc, opts),
      getRun: (profileId, runId) => getEngine().get(profileId, runId),
      listRuns: (profileId) => getEngine().list(profileId),
      getProfileManager: async () => profile,
    });
  app.post('/api/v1/deployments/validate', (request, reply) =>
    handlers().validateDeployment(request as never, reply)
  );
  app.post('/api/v1/deployments/runs', (request, reply) =>
    handlers().createDeploymentRun(request as never, reply)
  );
  app.get('/api/v1/deployments/runs/:runId', (request, reply) =>
    handlers().getDeploymentRun(request as never, reply)
  );
  app.post(
    '/api/v1/deployments/runs/:runId/lanes/:chainId/resolve',
    (request, reply) =>
      handlers().resolveDeploymentLane(request as never, reply)
  );
  app.post('/api/v1/deployments/runs/:runId/resume', (request, reply) =>
    handlers().resumeDeploymentRun(request as never, reply)
  );
  app.get('/api/v1/deployments/runs/:runId/artifact', (request, reply) =>
    handlers().getDeploymentArtifact(request as never, reply)
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

function makePlan(
  chains: number[],
  stepOverrides: Partial<Extract<DeploymentPlan['steps'][number], { kind: 'deploy' }>> = {}
): DeploymentPlan {
  return {
    schemaVersion: 1,
    contracts: [
      {
        id: 'token',
        repoPathOrUrl: FIXTURE,
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
        args: { name: 'Ignite Token', symbol: 'IGN', supply: '1000000' },
        ...stepOverrides,
      },
    ],
    chains,
    signers: {
      global: {
        pluginId: PRIVATE_KEY_PLUGIN_ID,
        accountId: KEY_ITEM_ID,
        address: ANVIL_ADDRESS,
      },
    },
  };
}

async function seedChainsAndRpc(
  ...anvils: Anvil[]
): Promise<Record<number, { id: string }>> {
  const registry = new ChainRegistry();
  const store = new RpcStore();
  const endpoints: Record<number, { id: string }> = {};
  for (const anvil of anvils) {
    await registry.upsertCustomChain({
      chainId: anvil.chainId,
      name: `Anvil ${anvil.chainId}`,
      shortName: `anvil${anvil.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpc: [],
    });
    endpoints[anvil.chainId] = await store.add(anvil.chainId, {
      url: anvil.rpcUrl,
      label: `Anvil ${anvil.chainId}`,
    });
  }
  return endpoints;
}

async function createRun(
  baseUrl: string,
  plan: DeploymentPlan,
  rpcSelection: Record<number, string>,
  label: string
): Promise<RunRecord> {
  const response = await httpJson<{ data: { run: RunRecord } }>(
    `${baseUrl}/api/v1/deployments/runs`,
    {
      method: 'POST',
      body: {
        plan,
        rpcSelection,
        name: label,
        idempotencyKey: crypto.randomUUID(),
      },
    }
  );
  return response.data.run;
}

async function resolveLane(
  baseUrl: string,
  runId: string,
  chainId: number,
  body: Record<string, unknown>
): Promise<RunRecord> {
  const response = await httpJson<{ data: { run: RunRecord } }>(
    `${baseUrl}/api/v1/deployments/runs/${runId}/lanes/${chainId}/resolve`,
    { method: 'POST', body }
  );
  return response.data.run;
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

function getBaseUrl(app: FastifyInstance): string {
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fastify did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}

async function httpJson<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      'x-ignite-token': TOKEN,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = (await response.json()) as T;
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function startAnvil(chainId: number): Promise<Anvil> {
  await ensureImage(ANVIL_IMAGE);
  const name = `ignite-deploy-anvil-${chainId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const container = await docker.createContainer({
    Image: ANVIL_IMAGE,
    name,
    Entrypoint: ['anvil'],
    Cmd: ['--host', '0.0.0.0', '--chain-id', String(chainId)],
    ExposedPorts: { '8545/tcp': {} },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { '8545/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
    },
  });
  await container.start();
  const info = await container.inspect();
  const port = info.NetworkSettings.Ports?.['8545/tcp']?.[0]?.HostPort;
  if (!port) throw new Error('Anvil did not publish port 8545/tcp');
  const rpcUrl = `http://127.0.0.1:${port}`;
  await waitForChainId(rpcUrl, chainId);
  return { container, rpcUrl, chainId };
}

async function consumeNonce(anvil: Anvil): Promise<void> {
  const chain = defineChain({
    id: anvil.chainId,
    name: `Anvil ${anvil.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [anvil.rpcUrl] } },
  });
  const wallet = createWalletClient({
    account: privateKeyToAccount(ANVIL_PRIVATE_KEY),
    chain,
    transport: http(anvil.rpcUrl),
  });
  const hash = await wallet.sendTransaction({ to: NONCE_CONSUMER, value: 0n });
  await createPublicClient({
    transport: http(anvil.rpcUrl),
  }).waitForTransactionReceipt({ hash });
}

async function setAutomine(anvil: Anvil, enabled: boolean): Promise<void> {
  await rpc(anvil.rpcUrl, 'anvil_setAutomine', [enabled]);
}

async function minePending(anvil: Anvil): Promise<void> {
  await rpc(anvil.rpcUrl, 'evm_mine', []);
  await setAutomine(anvil, true);
}

async function ensureImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    /* pull below */
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(
      image,
      (error: Error | null, stream?: NodeJS.ReadableStream) => {
        if (error) return reject(error);
        if (!stream)
          return reject(
            new Error(`Docker did not return a pull stream for ${image}`)
          );
        docker.modem.followProgress(stream, (progressError: Error | null) =>
          progressError ? reject(progressError) : resolve()
        );
      }
    );
  });
}

async function waitForChainId(rpcUrl: string, chainId: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const actual = await rpc(rpcUrl, 'eth_chainId', []);
      if (actual === `0x${chainId.toString(16)}`) return;
      throw new Error(`Unexpected chain id ${String(actual)}`);
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Timed out waiting for anvil: ${last instanceof Error ? last.message : String(last)}`
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
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (!response.ok || body.error)
    throw new Error(`RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}
