// D5 plan-engine integration proofs. These use fresh anvils and the compiled
// fixture repo; forge is intentionally never invoked by this suite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import fastify from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DeploymentPlan, RunRecord, Hex32 } from '@ignite/api';
import {
  CREATE2_PROXY_ADDRESS,
  CREATE2_PROXY_DEPLOYER_ADDRESS,
  CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX,
  CREATE2_PROXY_RUNTIME_HASH,
} from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';

const docker = new Docker();
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const PRIVATE_KEY_IMAGE = 'ignite/signer-provider_private-key:latest';
const SHARED_IMAGE = 'ignite/shared:latest';
const KEY_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const KEY_B = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const SIGNER_A = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const SIGNER_B = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const CHAIN_A = 31337;
const CHAIN_B = 31338;
const PRIVATE_KEY_PLUGIN = 'private-key';
const KEY_A_ID = 'planenga';
const KEY_B_ID = 'planengb';
const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plan-engine-repo');
const PLUGINS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../plugins');
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-plan-engine-'));
FileSystem.getInstance(HOME);

const { ChainRegistry } = await import('../../chains/ChainRegistry.js');
const { RpcStore } = await import('../../chains/RpcStore.js');
const { DeployEngine } = await import('../../deployments/DeployEngine.js');
const { validatePlan } = await import('../../deployments/validation.js');
const { renderArtifact } = await import('../../deployments/artifact.js');
const { createDeploymentHandlers } = await import('../../api/deployments.js');
const { SignerProviderService } = await import('../../signers/SignerProviderService.js');
const { VaultStore } = await import('../../plugins/vault/VaultStore.js');
const { PluginConfigStore } = await import('../../plugins/config/PluginConfigStore.js');
const { PluginExecutor } = await import('../../plugins/containers/PluginExecutor.js');
const { PluginInvoker } = await import('../../plugins/invoke/PluginInvoker.js');
const { ProfileManager } = await import('../../filesystem/ProfileManager.js');
const { PluginInstaller } = await import('../../plugins/install/PluginInstaller.js');
const { LocalFolderBuildBackend } = await import('../../plugins/install/LocalFolderBuildBackend.js');
const { TrustManager } = await import('../../plugins/trust/TrustManager.js');
const { DeploymentTypeService } = await import('../../deployments/DeploymentTypeService.js');

type Engine = InstanceType<typeof DeployEngine>;
type Anvil = { container: Docker.Container; rpcUrl: string; chainId: number };
let activeSigner: InstanceType<typeof SignerProviderService>;
let activeEngine: Engine;
let activeEndpoints: Record<number, { id: string }>;

export async function ensureCreate2Proxy(rpcUrl: string): Promise<void> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const existing = await publicClient.getCode({ address: CREATE2_PROXY_ADDRESS });
  if (existing && existing !== '0x') {
    expect(keccak256(existing)).toBe(CREATE2_PROXY_RUNTIME_HASH);
    return;
  }
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY_A), transport: http(rpcUrl) });
  const funding = await wallet.sendTransaction({ chain: undefined, to: CREATE2_PROXY_DEPLOYER_ADDRESS, value: 1_000_000_000_000_000_000n });
  await publicClient.waitForTransactionReceipt({ hash: funding });
  const tx = await publicClient.sendRawTransaction({ serializedTransaction: CREATE2_PROXY_PRESIGNED_DEPLOYMENT_TX });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  const runtime = await publicClient.getCode({ address: CREATE2_PROXY_ADDRESS });
  expect(runtime && keccak256(runtime)).toBe(CREATE2_PROXY_RUNTIME_HASH);
}

async function dockerReady(): Promise<boolean> { try { await docker.ping(); return true; } catch { return false; } }
const ready = await dockerReady();

describe.skipIf(!ready)('plan engine: CREATE2, pointers, calls, plugins', () => {
  let anvilA: Anvil;
  let anvilB: Anvil;
  let signerService: InstanceType<typeof SignerProviderService>;
  let engine: Engine;
  let endpoints: Record<number, { id: string }>;
  let deploymentTypeInstaller: InstanceType<typeof PluginInstaller>;

  beforeAll(async () => {
    for (const image of [ANVIL_IMAGE, PRIVATE_KEY_IMAGE, SHARED_IMAGE]) await docker.getImage(image).inspect();
    deploymentTypeInstaller = new PluginInstaller(new LocalFolderBuildBackend());
    await deploymentTypeInstaller.install({
      kind: 'local',
      contextDir: PLUGINS_DIR,
      dockerfile: 'examples/stub-deployment-type/Dockerfile',
    });
    await TrustManager.getInstance().setTrust('stub-deployment-type', 'trusted', {
      repoWrite: false,
      net: false,
      secrets: [],
    });
    DeploymentTypeService.getInstance().invalidate();
    signerService = activeSigner = await configureSigner();
    anvilA = await startAnvil(CHAIN_A);
    anvilB = await startAnvil(CHAIN_B);
    await Promise.all([ensureCreate2Proxy(anvilA.rpcUrl), ensureCreate2Proxy(anvilB.rpcUrl)]);
    endpoints = activeEndpoints = await seed(anvilA, anvilB);
    engine = activeEngine = makeEngine(signerService);
  }, 180_000);

  afterAll(async () => {
    await engine?.shutdown().catch(() => {});
    for (const anvil of [anvilA, anvilB]) await anvil?.container.stop({ t: 2 }).catch(() => {});
    DeploymentTypeService.getInstance().invalidate();
    await deploymentTypeInstaller?.uninstall('stub-deployment-type').catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('executes linked create2 plans and preserves v2 provenance', async () => {
    const plan = mainPlan([CHAIN_A, CHAIN_B]);
    const run = await launch(plan, [CHAIN_A, CHAIN_B], 'main');
    const complete = await waitForRun(run.id, (value) => value.status === 'completed');
    expect(complete.simulationTiers).toBeDefined();
    for (const anvil of [anvilA, anvilB]) {
      const key = String(anvil.chainId);
      const lane = complete.lanes[key];
      expect(lane.status).toBe('completed');
      expect(complete.simulationTiers?.[key]).toMatch(/^(simulateV1|fork)$/);
      const predicted = complete.validation.chains[key].create2!.details!.predicted as Record<string, { predictedAddress: Hex; initcodeHash: Hex }>;
      for (const id of ['math', 'box']) {
        const step = lane.steps.find((value) => value.stepId === id)!;
        expect(step.predictedAddress).toBe(predicted[id].predictedAddress);
        expect(step.address).toBe(predicted[id].predictedAddress);
        expect(await publicClient(anvil).getCode({ address: step.address! })).not.toBe('0x');
      }
      const counter = lane.steps.find((value) => value.stepId === 'counter')!;
      const math = lane.steps.find((value) => value.stepId === 'math')!;
      const counterCode = await publicClient(anvil).getCode({ address: counter.address! });
      expect(counterCode).toBeTruthy();
      expect(counterCode!.toLowerCase()).toContain(math.address!.slice(2).toLowerCase());
      expect(await readOwner(anvil, lane.steps.find((value) => value.stepId === 'box')!.address!)).toBe(SIGNER_A);
    }
    const artifact = renderArtifact(complete);
    expect(artifact.schemaVersion).toBe(2);
    for (const chainId of [CHAIN_A, CHAIN_B]) {
      const steps = artifact.lanes[String(chainId)].steps;
      expect(artifact.lanes[String(chainId)].simulationTier).toMatch(/^(simulateV1|fork)$/);
      for (const id of ['math', 'box']) {
        const step = steps.find((entry) => entry.stepId === id)!;
        expect(step.strategy).toMatchObject({ kind: 'create2', predictedAddress: complete.lanes[String(chainId)].steps.find((entry) => entry.stepId === id)!.predictedAddress });
        expect(step.attempts[0].expected).toBeDefined();
      }
      expect(steps.find((entry) => entry.stepId === 'counter')!.libraries).toEqual([{ key: 'src/MathLib.sol:MathLib', address: complete.lanes[String(chainId)].steps.find((entry) => entry.stepId === 'math')!.address!, source: { stepId: 'math' } }]);
      expect(steps.find((entry) => entry.stepId === 'counter')!.pointers).toEqual(expect.arrayContaining([{ path: 'args.owner_', stepId: 'box', address: complete.lanes[String(chainId)].steps.find((entry) => entry.stepId === 'box')!.address! }]));
      for (const id of ['give-b', 'give-a']) expect(steps.find((entry) => entry.stepId === id)!.call).toMatchObject({ target: complete.lanes[String(chainId)].steps.find((entry) => entry.stepId === 'box')!.address, targetSource: { stepId: 'box' }, signature: 'transferOwnership(address)' });
    }
  }, 180_000);

  it('acknowledges deterministic deployments without consuming signer nonces', async () => {
    const first = await launch(mainPlan([CHAIN_A], 100), [CHAIN_A], 'ack-source');
    const source = await waitForRun(first.id, (value) => value.status === 'completed');
    const lane = source.lanes[String(CHAIN_A)];
    const predicted = source.validation.chains[String(CHAIN_A)].create2!.details!.predicted as Record<string, { predictedAddress: Hex; initcodeHash: Hex }>;
    const plan = mainPlan([CHAIN_A], 100);
    for (const id of ['math', 'box']) {
      const step = plan.steps.find((value) => value.id === id)!;
      if (step.kind === 'deploy' && step.strategy?.kind === 'create2') step.strategy.acknowledgeDeployed = { [CHAIN_A]: predicted[id] };
    }
    const before = await publicClient(anvilA).getTransactionCount({ address: SIGNER_A });
    const beforeB = await publicClient(anvilA).getTransactionCount({ address: SIGNER_B });
    const rerun = await launch(plan, [CHAIN_A], 'ack-rerun');
    const complete = await waitForRun(rerun.id, (value) => value.status === 'completed');
    const after = await publicClient(anvilA).getTransactionCount({ address: SIGNER_A });
    const afterB = await publicClient(anvilA).getTransactionCount({ address: SIGNER_B });
    const rerunLane = complete.lanes[String(CHAIN_A)];
    for (const id of ['math', 'box']) {
      const step = rerunLane.steps.find((value) => value.stepId === id)!;
      expect(step).toMatchObject({ status: 'skipped', address: lane.steps.find((value) => value.stepId === id)!.address });
      expect(step.attempts).toHaveLength(0);
    }
    expect(rerunLane.steps.find((value) => value.stepId === 'counter')!.address).not.toBe(lane.steps.find((value) => value.stepId === 'counter')!.address);
    expect(after - before).toBe(2); // counter create + first ownership call
    expect(afterB - beforeB).toBe(1); // override-signed second ownership call
  }, 180_000);

  it('supports forward CREATE2 references and rejects prediction cycles', async () => {
    const forward = simpleBoxPlan('forward', [
      { id: 'a', peer: { $ref: { kind: 'step', stepId: 'b' } } },
      { id: 'b', peer: ZERO },
    ]);
    const run = await launch(forward, [CHAIN_A], 'forward-ref');
    const complete = await waitForRun(run.id, (value) => value.status === 'completed');
    const lane = complete.lanes[String(CHAIN_A)];
    expect((await readPeer(anvilA, lane.steps[0].address!)).toLowerCase()).toBe(lane.steps[1].address!.toLowerCase());

    const cycle = simpleBoxPlan('cycle', [
      { id: 'a', peer: { $ref: { kind: 'step', stepId: 'b' } } },
      { id: 'b', peer: { $ref: { kind: 'step', stepId: 'a' } } },
    ]);
    const result = await validate(cycle, [CHAIN_A]);
    expect(result.report.chains[String(CHAIN_A)].args).toMatchObject({ ok: false, blocking: true, code: 'CREATE2_PREDICTION_CYCLE' });
  }, 180_000);

  it('prepares, validates, and deploys through an installed deployment-type plugin', async () => {
    const step = hookPlan().steps[0];
    const app = fastify({ logger: false });
    const profile = await ProfileManager.getInstance();
    const handlers = createDeploymentHandlers({
      getProfileManager: async () => profile,
      freezeInputs: async (profileId, contracts) => (await validatePlan({ ...hookPlan(), contracts, steps: [step] }, { [CHAIN_A]: endpoints[CHAIN_A].id }, validationOverrides(profileId))).frozen,
    });
    app.post('/api/v1/deployments/steps/prepare', (request, reply) => handlers.prepareDeploymentStep(request as never, reply));
    const preparedResponse = await app.inject({ method: 'POST', url: '/api/v1/deployments/steps/prepare', payload: { contracts: hookPlan().contracts, steps: [step], stepId: 'hook', chainIds: [CHAIN_A] } });
    expect(preparedResponse.statusCode).toBe(200);
    const prepared = (preparedResponse.json() as { data: { chains: Record<string, { salt: Hex; predictedAddress: Hex; initcodeHash: Hex }> } }).data.chains[String(CHAIN_A)];
    await app.close();
    const plan = hookPlan();
    const hook = plan.steps[0];
    if (hook.kind === 'deploy' && hook.strategy?.kind === 'plugin') {
      // The wizard writes the mined salt AND the commitment (spec §7.3).
      hook.strategy.salt = prepared.salt as Hex32;
      hook.strategy.prepared = { [CHAIN_A]: { initcodeHash: prepared.initcodeHash as Hex32, predictedAddress: prepared.predictedAddress } };
    }
    const validation = await validate(plan, [CHAIN_A]);
    expect(validation.report.chains[String(CHAIN_A)].create2).toMatchObject({ ok: true });
    const run = await launch(plan, [CHAIN_A], 'hook');
    const complete = await waitForRun(run.id, (value) => value.status === 'completed');
    const address = complete.lanes[String(CHAIN_A)].steps[0].address!;
    expect(Number(BigInt(address) & 0xffn)).toBe(0xc0);
    const stale = structuredClone(plan);
    if (stale.steps[0].kind === 'deploy') {
      stale.steps[0].args = { owner_: SIGNER_B, peer_: ZERO };
    }
    expect((await validate(stale, [CHAIN_A])).report.chains[String(CHAIN_A)].create2).toMatchObject({ ok: false, blocking: true, code: 'DEPLOYMENT_TYPE_COMMITMENT_STALE' });
  }, 420_000);
});

function contracts() {
  return [
    ['math', 'out/MathLib.sol/MathLib.json', 'MathLib', 'src/MathLib.sol'],
    ['box', 'out/OwnedBox.sol/OwnedBox.json', 'OwnedBox', 'src/OwnedBox.sol'],
    ['counter', 'out/LinkedCounter.sol/LinkedCounter.json', 'LinkedCounter', 'src/LinkedCounter.sol'],
    ['hook', 'out/MiniHook.sol/MiniHook.json', 'MiniHook', 'src/MiniHook.sol'],
  ].map(([id, artifactPath, contractName, sourcePath]) => ({ id, repoPathOrUrl: FIXTURE, frameworkId: 'foundry', artifactPath, contractName, sourcePath }));
}

function base(chains: number[]): Pick<DeploymentPlan, 'schemaVersion' | 'contracts' | 'chains' | 'signers'> {
  return { schemaVersion: 1, contracts: contracts(), chains, signers: { global: { pluginId: PRIVATE_KEY_PLUGIN, accountId: KEY_A_ID, address: SIGNER_A } } };
}
function salt(n: number): Hex { return `0x${n.toString(16).padStart(64, '0')}` as Hex; }
function mainPlan(chains: number[], saltOffset = 0): DeploymentPlan {
  return { ...base(chains), steps: [
    { id: 'math', kind: 'deploy', contractId: 'math', strategy: { kind: 'create2', salt: salt(0xd5001 + saltOffset) } },
    { id: 'box', kind: 'deploy', contractId: 'box', args: { owner_: SIGNER_A, peer_: ZERO }, strategy: { kind: 'create2', salt: salt(0xd5002 + saltOffset) } },
    { id: 'counter', kind: 'deploy', contractId: 'counter', args: { owner_: { $ref: { kind: 'step', stepId: 'box' } }, peer_: { $ref: { kind: 'step', stepId: 'box' } } }, libraries: { 'src/MathLib.sol:MathLib': { kind: 'step', stepId: 'math' } } },
    { id: 'give-b', kind: 'call', target: { kind: 'step', stepId: 'box' }, signature: 'transferOwnership(address)', payable: false, args: { nextOwner: SIGNER_B } },
    { id: 'give-a', kind: 'call', target: { kind: 'step', stepId: 'box' }, signature: 'transferOwnership(address)', payable: false, args: { nextOwner: SIGNER_A }, signerOverride: { global: { pluginId: PRIVATE_KEY_PLUGIN, accountId: KEY_B_ID, address: SIGNER_B } } },
  ] };
}
function simpleBoxPlan(name: string, boxes: Array<{ id: string; peer: unknown }>): DeploymentPlan {
  return { ...base([CHAIN_A]), steps: boxes.map((box, index) => ({ id: `${name}-${box.id}`, kind: 'deploy' as const, contractId: 'box', args: { owner_: SIGNER_A, peer_: box.peer }, strategy: { kind: 'create2' as const, salt: salt(30 + index) } })).map((step, _, all) => ({ ...step, args: { ...step.args, peer_: typeof step.args.peer_ === 'object' && step.args.peer_ ? { $ref: { kind: 'step', stepId: `${name}-${(step.args.peer_ as { $ref: { stepId: string } }).$ref.stepId}` } } : step.args.peer_ } })) };
}
// peer_: SIGNER_B keeps this step's initcode unique within the suite: the
// stub mines deterministic counter salts from 0 over the SAME encoding the
// salt() helper uses, so sharing initcode with a create2 test (e.g. the
// forward plan's box at salt 31) parks real code on the mined address and
// full-file runs fail CREATE2_ALREADY_DEPLOYED while isolated runs pass.
function hookPlan(): DeploymentPlan { return { ...base([CHAIN_A]), steps: [{ id: 'hook', kind: 'deploy', contractId: 'box', args: { owner_: SIGNER_A, peer_: SIGNER_B }, strategy: { kind: 'plugin', pluginId: 'stub-deployment-type' } }] }; }

function validationOverrides(profileId = 'default') {
  return { profileId, listAccounts: async () => (await activeSigner.listAccounts(true)).providers };
}
function makeEngine(service: InstanceType<typeof SignerProviderService>): Engine {
  return new DeployEngine({ executeTx: service.executeTx.bind(service), resolveAccount: service.resolveAccount.bind(service), validate: (plan, selection, options) => validatePlan(plan, selection, validationOverrides(options?.profileId)), chainMetadata: async (chainId) => ({ name: `Anvil ${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }) });
}
async function validate(plan: DeploymentPlan, chains: number[]) { return validatePlan(plan, Object.fromEntries(chains.map((chainId) => [chainId, activeEndpoints[chainId].id])), validationOverrides()); }
async function launch(plan: DeploymentPlan, chains: number[], name: string) { return activeEngine.launch({ profileId: 'default', plan, rpcSelection: Object.fromEntries(chains.map((chainId) => [chainId, activeEndpoints[chainId].id])), name, idempotencyKey: crypto.randomUUID() }); }
async function waitForRun(id: string, predicate: (run: RunRecord) => boolean): Promise<RunRecord> { const deadline = Date.now() + 120_000; let result: RunRecord | undefined; while (Date.now() < deadline) { result = await activeEngine.get('default', id); if (result && predicate(result)) return result; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`Timed out: ${JSON.stringify(result)}`); }
async function configureSigner(): Promise<InstanceType<typeof SignerProviderService>> { const vault = new VaultStore({ getMasterKey: async () => Buffer.alloc(32, 7) }); const config = new PluginConfigStore(); await config.setValue(PRIVATE_KEY_PLUGIN, 'keys', [{ id: KEY_A_ID, values: { label: 'A' } }, { id: KEY_B_ID, values: { label: 'B' } }]); await vault.setSecret(PRIVATE_KEY_PLUGIN, `keys.${KEY_A_ID}.private-key`, KEY_A); await vault.setSecret(PRIVATE_KEY_PLUGIN, `keys.${KEY_B_ID}.private-key`, KEY_B); const executor = new PluginExecutor({ vaultStore: vault }); const invoker = new PluginInvoker({ executeContainer: (id, operation, options, opts) => executor.execute(id, operation, options, opts) }); return new SignerProviderService({ invoke: (id, operation, params, opts) => invoker.invoke(id, operation, params, opts) }); }
async function startAnvil(chainId: number): Promise<Anvil> { const container = await docker.createContainer({ Image: ANVIL_IMAGE, Entrypoint: ['anvil'], Cmd: ['--host', '0.0.0.0', '--chain-id', String(chainId)], ExposedPorts: { '8545/tcp': {} }, HostConfig: { AutoRemove: true, PortBindings: { '8545/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] } } }); await container.start(); const port = (await container.inspect()).NetworkSettings.Ports?.['8545/tcp']?.[0]?.HostPort; if (!port) throw new Error('anvil port missing'); const rpcUrl = `http://127.0.0.1:${port}`; for (let n = 0; n < 100; n += 1) { try { if (await createPublicClient({ transport: http(rpcUrl) }).getChainId() === chainId) return { container, rpcUrl, chainId }; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('anvil did not start'); }
async function seed(...anvils: Anvil[]): Promise<Record<number, { id: string }>> { const registry = new ChainRegistry(); const store = new RpcStore(); const result: Record<number, { id: string }> = {}; for (const anvil of anvils) { await registry.upsertCustomChain({ chainId: anvil.chainId, name: `Anvil ${anvil.chainId}`, shortName: `anvil${anvil.chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpc: [] }); result[anvil.chainId] = await store.add(anvil.chainId, { url: anvil.rpcUrl, label: `Anvil ${anvil.chainId}` }); } return result; }
function publicClient(anvil: Anvil) { return createPublicClient({ transport: http(anvil.rpcUrl) }); }
const boxAbi = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }, { type: 'function', name: 'peer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
async function readOwner(anvil: Anvil, address: Hex) { return getAddress(await publicClient(anvil).readContract({ address, abi: boxAbi, functionName: 'owner' })); }
async function readPeer(anvil: Anvil, address: Hex) { return getAddress(await publicClient(anvil).readContract({ address, abi: boxAbi, functionName: 'peer' })); }
