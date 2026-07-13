// Docker-to-host reachability seam used by verifier containers. The full
// deployRun suite owns the anvil direction (host -> container); verification
// reverses that direction because explorer test servers run on the host.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Docker from 'dockerode';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http as viemHttp,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DeploymentPlan, RunRecord, VerificationTask } from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';

const execFileAsync = promisify(execFile);
const docker = new Docker();
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const ANVIL_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const ANVIL_ADDRESS = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const CHAIN_ID = 31337;
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'deploy-repo'
);

const IGNITE_HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-verification-e2e-')
);
FileSystem.resetInstance();
FileSystem.getInstance(IGNITE_HOME);

const { ChainRegistry } = await import('../../chains/ChainRegistry.js');
const { RpcStore } = await import('../../chains/RpcStore.js');
const { ExplorerStore } = await import('../../chains/ExplorerStore.js');
const { DeployEngine } = await import('../../deployments/DeployEngine.js');
const { validatePlan } = await import('../../deployments/validation.js');
const { VerificationQueue } = await import(
  '../../verifications/VerificationQueue.js'
);
const { wireVerificationReconciliation } = await import(
  '../../deployments/verificationIntegration.js'
);
const { VaultStore } = await import('../../plugins/vault/VaultStore.js');
const { TrustManager } = await import('../../plugins/trust/TrustManager.js');
const { ProfileManager } = await import('../../filesystem/ProfileManager.js');
const { createVerificationHandlers } = await import(
  '../../api/verifications.js'
);

let server: http.Server | undefined;
let apiUrl = '';
let reachable = false;
let explorerState = {
  submits: [] as Array<Record<string, string>>,
  polls: [] as string[],
  creationTxHash: '',
};

type Anvil = { container: Docker.Container; rpcUrl: string };

async function dockerHostAddress(): Promise<string> {
  if (process.platform === 'darwin' || process.platform === 'win32')
    return 'host.docker.internal';
  const inspected = await execFileAsync('docker', [
    'network',
    'inspect',
    'bridge',
    '--format',
    '{{(index .IPAM.Config 0).Gateway}}',
  ]);
  const gateway = inspected.stdout.trim();
  if (!gateway) throw new Error('Docker bridge has no gateway address');
  return gateway;
}

async function probe(url: string): Promise<boolean> {
  try {
    await execFileAsync('docker', [
      'run',
      '--rm',
      'alpine:3.20',
      'wget',
      '-qO-',
      '-T',
      '5',
      `${url}/health`,
    ]);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (url.pathname === '/health') {
      response.writeHead(200);
      response.end('ok');
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const form = new URLSearchParams(body);
    const action = form.get('action') ?? url.searchParams.get('action');
    response.setHeader('content-type', 'application/json');
    if (action === 'verifysourcecode') {
      explorerState.submits.push(Object.fromEntries(form.entries()));
      const retry = explorerState.submits.length <= 2;
      response.end(
        JSON.stringify(
          retry
            ? { status: '0', result: 'temporary not indexed yet' }
            : { status: '1', result: 'guid-verification-123' }
        )
      );
      return;
    }
    if (action === 'checkverifystatus') {
      explorerState.polls.push(url.searchParams.get('guid') ?? '');
      response.end(
        JSON.stringify({
          status: '1',
          result:
            explorerState.polls.length === 1
              ? 'Pending in queue'
              : 'Pass - Verified',
        })
      );
      return;
    }
    if (action === 'getcontractcreation') {
      response.end(
        JSON.stringify({
          status: '1',
          result: [{ txHash: explorerState.creationTxHash }],
        })
      );
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'unknown explorer action' }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    apiUrl = `http://${await dockerHostAddress()}:${port}`;
    reachable = await probe(apiUrl);
  } catch {
    reachable = false;
  }
  if (!reachable)
    console.warn(
      'SKIP verification integration: Docker container cannot reach host mock explorer'
    );
}, 30_000);

afterAll(async () => {
  VerificationQueue.resetInstance();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await fs.rm(IGNITE_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('verification Docker host bridge', () => {
  it('allows a verifier container to reach the host mock explorer', () => {
    if (!reachable) return;
    expect(apiUrl).toMatch(/^http:\/\//);
    expect(os.platform()).toBe(process.platform);
  });
});

describe('verification lifecycle through a launched run', () => {
  let anvil: Anvil | undefined;
  let engine: InstanceType<typeof DeployEngine> | undefined;

  afterAll(async () => {
    await engine?.shutdown().catch(() => {});
    await anvil?.container.stop({ t: 2 }).catch(() => {});
  });

  it('retries, recovers a persisted GUID, reconciles, and round-trips guessed args', async () => {
    if (!reachable) return;
    await assertImages();
    await ProfileManager.getInstance();
    explorerState = { submits: [], polls: [], creationTxHash: '' };
    anvil = await startAnvil();
    await ensureTrust('etherscan', {
      net: true,
      repoWrite: false,
      secrets: ['apiKey'],
    });
    await new VaultStore().setSecret(
      'etherscan',
      'apiKey',
      'integration-api-key'
    );

    const rpc = await seedChainAndRpc(anvil);
    const explorer = await new ExplorerStore().add({
      chainId: CHAIN_ID,
      url: apiUrl,
      apiUrl,
      label: 'Mock Etherscan',
      verifierPluginId: 'etherscan',
    });
    await new ExplorerStore().setSelection(CHAIN_ID, [explorer.id]);

    let queue = VerificationQueue.getInstance();
    wireVerificationReconciliation(queue);
    const signer = anvilSigner(anvil.rpcUrl);
    engine = new DeployEngine({
      executeTx: signer.executeTx,
      resolveAccount: signer.resolveAccount,
      validate: (plan, selection, options) =>
        validatePlan(plan, selection, {
          profileId: options?.profileId,
          explorerSelection: options?.explorerSelection,
          listAccounts: async () => [
            {
              pluginId: 'anvil-key',
              name: 'Anvil key',
              state: 'ok',
              accounts: [{ id: 'anvil-key', address: ANVIL_ADDRESS }],
            },
          ],
        }),
      verificationQueue: queue,
      chainMetadata: async () => ({
        name: 'Anvil verification',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      }),
    });
    const preflight = await validatePlan(
      makePlan(),
      { [CHAIN_ID]: rpc.id },
      {
        profileId: 'default',
        explorerSelection: { [CHAIN_ID]: [explorer.id] },
        listAccounts: async () => [
          {
            pluginId: 'anvil-key',
            name: 'Anvil key',
            state: 'ok',
            accounts: [{ id: 'anvil-key', address: ANVIL_ADDRESS }],
          },
        ],
      }
    );
    const blocking = Object.values(
      preflight.report.chains[String(CHAIN_ID)]
    ).filter((item) => item.blocking && !item.ok);
    expect(
      blocking,
      JSON.stringify(preflight.report.chains[String(CHAIN_ID)])
    ).toEqual([]);
    const run = await engine.launch({
      profileId: 'default',
      plan: makePlan(),
      rpcSelection: { [CHAIN_ID]: rpc.id },
      explorerSelection: { [CHAIN_ID]: [explorer.id] },
      name: 'verification lifecycle',
      idempotencyKey: crypto.randomUUID(),
    });
    const completed = await waitForRun(
      engine,
      run.id,
      (candidate) => candidate.status === 'completed'
    );
    const lane = completed.lanes[String(CHAIN_ID)];
    expect(lane.status).toBe('completed');
    expect(lane.pause).toBeUndefined();
    const step = lane.steps[0];
    const address = step.address!;
    const creationTxHash = step.attempts[0].txHash!;
    explorerState.creationTxHash = creationTxHash;

    let task = await waitForTask(
      queue,
      run.id,
      (candidate) =>
        candidate.status === 'queued' && candidate.attempts.length === 1
    );
    expect(task.detail).toMatch(/^RETRYABLE/);
    expect(task.nextAttemptAt).toBeDefined();
    task = await waitForTask(
      queue,
      run.id,
      (candidate) =>
        candidate.status === 'queued' && candidate.attempts.length === 2
    );
    expect(task.detail).toMatch(/^RETRYABLE/);
    expect(task.nextAttemptAt).toBeDefined();
    task = await waitForTask(
      queue,
      run.id,
      (candidate) =>
        candidate.status === 'polling' &&
        candidate.attempts.some(
          (attempt) => attempt.pollTicket === 'guid-verification-123'
        )
    );
    expect(explorerState.submits).toHaveLength(3);

    const bundleHash = completed.inputs.token.bundleHash!;
    const bundlePath = path.join(
      IGNITE_HOME,
      'profiles',
      'default',
      'deployments',
      'bundles',
      `${bundleHash}.json`
    );
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8')) as {
      standardJsonInput: { sources: unknown; settings: unknown };
    };
    const submittedInput = JSON.parse(explorerState.submits[2].sourceCode) as {
      sources: unknown;
      settings: unknown;
    };
    expect(JSON.stringify(submittedInput.sources)).toBe(
      JSON.stringify(bundle.standardJsonInput.sources)
    );
    expect(JSON.stringify(submittedInput.settings)).toBe(
      JSON.stringify(bundle.standardJsonInput.settings)
    );
    const transaction = await createPublicClient({
      transport: viemHttp(anvil.rpcUrl),
    }).getTransaction({ hash: creationTxHash as Hex });
    const creationCode = completed.inputs.token.creationBytecode;
    expect(explorerState.submits[2].constructorArguements).toBe(
      transaction.input.slice(creationCode.length).replace(/^0x/, '')
    );
    expect(lane.pause).toBeUndefined();

    // The first poll is pending. Drop the singleton while the persisted GUID
    // is live, then let startup recovery resume that exact ticket.
    await waitForCondition(
      () => explorerState.polls.length === 1,
      'first verification poll'
    );
    expect(explorerState.polls).toEqual(['guid-verification-123']);
    VerificationQueue.resetInstance();
    queue = VerificationQueue.getInstance();
    wireVerificationReconciliation(queue);
    await queue.recoverStartup();
    task = await waitForTask(
      queue,
      run.id,
      (candidate) => candidate.status === 'verified'
    );
    expect(
      task.attempts.some(
        (attempt) => attempt.pollTicket === 'guid-verification-123'
      )
    ).toBe(true);
    expect(explorerState.polls).toEqual([
      'guid-verification-123',
      'guid-verification-123',
    ]);
    expect((await engine.get('default', run.id))?.status).toBe('completed');

    await fs.rm(
      path.join(
        IGNITE_HOME,
        'profiles',
        'default',
        'verifications',
        'tasks.json'
      )
    );
    await queue.reconcile();
    const reconciled = await waitForTask(
      queue,
      run.id,
      (candidate) => candidate.address.toLowerCase() === address.toLowerCase()
    );
    expect(reconciled.origin).toMatchObject({
      runId: run.id,
      stepId: 'deploy-token',
    });
    queue.stop();

    const handlers = createVerificationHandlers();
    const guessed = await invokeHandler(handlers.guessConstructorArgs, {
      contract: makePlan().contracts[0],
      chainId: CHAIN_ID,
      address,
    });
    expect(guessed.data).toMatchObject({
      args: { name: 'Ignite Token', symbol: 'IGN', supply: '1000000' },
    });
    const created = await invokeHandler(handlers.createVerification, {
      contract: makePlan().contracts[0],
      chainId: CHAIN_ID,
      address,
      explorerEntryIds: [explorer.id],
      args: guessed.data.args,
      creationTxHash,
    });
    expect(created.data.tasks).toHaveLength(1);
    queue.stop();
  }, 180_000);
});

async function assertImages(): Promise<void> {
  for (const image of [
    'ignite/signer-provider_private-key:latest',
    'ignite/compiler_foundry:latest',
    'ignite/verifier_etherscan:latest',
  ]) {
    try {
      await docker.getImage(image).inspect();
    } catch {
      throw new Error(
        `Built-in image ${image} is unavailable. Run \`cd plugins && npm run build\` before this integration suite.`
      );
    }
  }
}

async function ensureTrust(
  pluginId: string,
  permissions: { net: boolean; repoWrite: boolean; secrets: string[] }
): Promise<void> {
  const trust = TrustManager.getInstance();
  if ((await trust.getGrant(pluginId)).trust !== 'native') {
    await trust.setTrust(pluginId, 'trusted', permissions);
  }
}

function makePlan(): DeploymentPlan {
  return {
    schemaVersion: 1,
    chains: [CHAIN_ID],
    contracts: [
      {
        id: 'token',
        repoPathOrUrl: FIXTURE,
        frameworkId: 'foundry',
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
      },
    ],
    signers: {
      global: {
        pluginId: 'anvil-key',
        accountId: 'anvil-key',
        address: ANVIL_ADDRESS,
      },
    },
  };
}

function anvilSigner(rpcUrl: string) {
  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Verification Anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
  return {
    resolveAccount: async () => ({
      account: {
        id: 'anvil-key',
        address: ANVIL_ADDRESS,
        capability: 'sign-and-send' as const,
      },
    }),
    executeTx: async (args: {
      to: Hex | null;
      data: Hex;
      value: bigint;
      onPhase?: (
        phase: 'built' | 'signed' | 'broadcasting',
        data: { tx: { nonce: number } }
      ) => Promise<void>;
    }) => {
      const wallet = createWalletClient({
        account,
        chain,
        transport: viemHttp(rpcUrl),
      });
      // The real SignerProviderService emits 'built' before any submission;
      // Attempt.expected (and therefore verification enqueue) depends on it.
      const nonce = await createPublicClient({
        transport: viemHttp(rpcUrl),
      }).getTransactionCount({ address: ANVIL_ADDRESS, blockTag: 'pending' });
      await args.onPhase?.('built', { tx: { nonce } });
      const hash = await wallet.sendTransaction({
        to: args.to ?? undefined,
        data: args.data,
        value: args.value,
      });
      const receipt = await createPublicClient({
        transport: viemHttp(rpcUrl),
      }).waitForTransactionReceipt({ hash });
      return {
        txHash: hash,
        status: receipt.status,
        blockNumber: Number(receipt.blockNumber),
        contractAddress: receipt.contractAddress ?? null,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      };
    },
  };
}

async function seedChainAndRpc(anvil: Anvil): Promise<{ id: string }> {
  await new ChainRegistry().upsertCustomChain({
    chainId: CHAIN_ID,
    name: 'Verification Anvil',
    shortName: 'verification-anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [],
  });
  return new RpcStore().add(CHAIN_ID, {
    url: anvil.rpcUrl,
    label: 'Verification Anvil',
  });
}

async function startAnvil(): Promise<Anvil> {
  const name = `ignite-verification-anvil-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const container = await docker.createContainer({
    Image: ANVIL_IMAGE,
    name,
    Entrypoint: ['anvil'],
    Cmd: ['--host', '0.0.0.0', '--chain-id', String(CHAIN_ID)],
    ExposedPorts: { '8545/tcp': {} },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { '8545/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
    },
  });
  await container.start();
  const port = (await container.inspect()).NetworkSettings.Ports?.[
    '8545/tcp'
  ]?.[0]?.HostPort;
  if (!port) throw new Error('Anvil did not publish port 8545/tcp');
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_chainId',
          params: [],
        }),
      });
      if (((await response.json()) as { result?: string }).result === '0x7a69')
        return { container, rpcUrl };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for anvil');
}

async function waitForRun(
  engine: InstanceType<typeof DeployEngine>,
  runId: string,
  predicate: (run: RunRecord) => boolean
): Promise<RunRecord> {
  const deadline = Date.now() + 45_000;
  let last: RunRecord | undefined;
  while (Date.now() < deadline) {
    last = await engine.get('default', runId);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for deployment run: ${JSON.stringify(last)}`
  );
}

async function waitForTask(
  queue: InstanceType<typeof VerificationQueue>,
  runId: string,
  predicate: (task: VerificationTask) => boolean
): Promise<VerificationTask> {
  const deadline = Date.now() + 75_000;
  let last: VerificationTask[] = [];
  while (Date.now() < deadline) {
    last = await queue.store.list('default', { runId });
    const task = last.find(predicate);
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for verification task: ${JSON.stringify(last)}`
  );
}

async function waitForCondition(
  predicate: () => boolean,
  name: string
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${name}`);
}

async function invokeHandler(
  handler: (request: never, reply: never) => Promise<unknown>,
  body: Record<string, unknown>
): Promise<any> {
  let payload: unknown;
  const reply = {
    status: () => reply,
    send: (value: unknown) => {
      payload = value;
      return value;
    },
  };
  await handler({ body } as never, reply as never);
  return payload;
}
