// D6 two-phase promotion proof: an ephemeral anvil run is promoted into a
// pinned workflow, adopted into the target repo, resolved, and run again.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import type { FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http, type Hex } from 'viem';
import type { DeploymentPlan, JobRecord, RunRecord, WorkflowDocument } from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';

const exec = promisify(execFile);
const docker = new Docker();
const CHAIN_ID = 31339;
const PROFILE = 'workflow-promotion';
const WORKFLOW = 'promoted-release';
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const FOUNDRY_IMAGE = 'ignite/compiler_foundry:latest';
const PRIVATE_KEY_IMAGE = 'ignite/signer-provider_private-key:latest';
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SIGNER = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const KEY_ID = 'promotionkey';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'workflow-repo-v2');
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflow-promotion-'));
FileSystem.getInstance(HOME);

const { ChainRegistry } = await import('../../chains/ChainRegistry.js');
const { RpcStore } = await import('../../chains/RpcStore.js');
const { DeployEngine } = await import('../../deployments/DeployEngine.js');
const { validatePlan } = await import('../../deployments/validation.js');
const { createDeploymentHandlers } = await import('../../api/deployments.js');
const { createWorkflowHandlers } = await import('../../api/workflows.js');
const { WorkflowPromotionService } = await import('../../workflows/WorkflowPromotionService.js');
const { SignerProviderService } = await import('../../signers/SignerProviderService.js');
const { VaultStore } = await import('../../plugins/vault/VaultStore.js');
const { PluginConfigStore } = await import('../../plugins/config/PluginConfigStore.js');
const { PluginExecutor } = await import('../../plugins/containers/PluginExecutor.js');
const { PluginInvoker } = await import('../../plugins/invoke/PluginInvoker.js');
const { RepoService } = await import('../../repos/RepoService.js');
const { PinnedStore } = await import('../../repos/PinnedStore.js');
const { JobManager } = await import('../../jobs/JobManager.js');

type Anvil = { container: Docker.Container; rpcUrl: string };
let ready = false;
try {
  await docker.ping();
  for (const image of [ANVIL_IMAGE, FOUNDRY_IMAGE, PRIVATE_KEY_IMAGE]) await docker.getImage(image).inspect();
  ready = true;
} catch { /* Docker-gated */ }

describe.skipIf(!ready)('workflow promotion integration (offline)', () => {
  let temp: string;
  let source: string;
  let origin: string;
  let commit: string;
  let target: string;
  let anvil: Anvil;
  let rpcId: string;
  let signer: InstanceType<typeof SignerProviderService>;
  let engine: InstanceType<typeof DeployEngine>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-promotion-fixtures-'));
    source = path.join(temp, 'source');
    const bare = path.join(temp, 'source-remote');
    await fs.cp(FIXTURE, source, { recursive: true });
    await initGit(source, 'source v2');
    await git(source, ['tag', 'v2.0.0']);
    commit = (await git(source, ['rev-parse', 'HEAD'])).trim();
    await exec('git', ['clone', '--bare', source, bare]);
    origin = pathToFileURL(bare).href;
    await git(source, ['remote', 'add', 'origin', origin]);

    target = path.join(temp, 'target');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'README.md'), '# Promotion target\n');
    await initGit(target, 'target');

    signer = await configureSigner();
    anvil = await startAnvil();
    rpcId = await seedRpc(anvil.rpcUrl);
    engine = new DeployEngine({
      executeTx: signer.executeTx.bind(signer),
      resolveAccount: signer.resolveAccount.bind(signer),
      validate: (plan, selection, options) => validatePlan(plan, selection, { ...options, listAccounts: async () => (await signer.listAccounts(true)).providers, captureBundles: async () => ({}) }),
      chainMetadata: async (chainId) => ({ chainId, name: `Anvil ${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }),
    });
  }, 180_000);

  afterAll(async () => {
    await engine?.shutdown().catch(() => {});
    await anvil?.container.stop({ t: 2 }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    delete process.env.NODE_ENV;
  });

  it('previews, applies, adopts, resolves, and re-runs a promoted workflow', async () => {
    const plan: DeploymentPlan = {
      schemaVersion: 1,
      contracts: [{ id: 'box', repoPathOrUrl: source, frameworkId: 'foundry', sourcePath: 'src/VersionedBox.sol', contractName: 'VersionedBox', artifactPath: 'out/VersionedBox.sol/VersionedBox.json' }],
      steps: [{ id: 'deploy', kind: 'deploy', contractId: 'box', args: { owner_: SIGNER }, signerOverride: { global: { pluginId: 'private-key', accountId: KEY_ID, address: SIGNER } } }],
      chains: [CHAIN_ID],
      signers: signerCascade(),
    };
    const first = await engine.launch({ profileId: PROFILE, plan, rpcSelection: { [CHAIN_ID]: rpcId }, name: 'ephemeral promotion source', idempotencyKey: crypto.randomUUID() });
    const completed = await waitForRun(first.id, (run) => run.status === 'completed');

    const promotions = new WorkflowPromotionService();
    const preview = await promotions.promote({ mode: 'preview', target: { repoPathOrUrl: target, name: WORKFLOW }, runId: completed.id }, PROFILE);
    expect(preview).toMatchObject({ mode: 'preview', nameCollision: false, sources: [{ sourceId: 'box', origin, commit, tagChoices: ['v2.0.0'], dirty: false }] });
    expect(await exists(path.join(target, 'ignite', 'workflows', `${WORKFLOW}.json`))).toBe(false);

    const applied = await promotions.promote({
      mode: 'apply', previewId: preview.previewId, target: { repoPathOrUrl: target, name: WORKFLOW }, runId: completed.id,
      hooks: [], adoptRunIds: [completed.id, completed.id],
    }, PROFILE);
    expect(applied).toMatchObject({ mode: 'apply', workflow: { name: WORKFLOW, valid: true } });

    const document = JSON.parse(await fs.readFile(path.join(target, 'ignite', 'workflows', `${WORKFLOW}.json`), 'utf8')) as WorkflowDocument;
    expect(document).not.toHaveProperty('signers');
    expect(document.steps).toEqual([{ id: 'deploy', kind: 'deploy', contractId: 'box', args: { owner_: SIGNER } }]);
    expect(document.sources).toEqual([{
      id: 'box', repo: { url: origin, commit, ref: 'v2.0.0', refKind: 'tag' }, frameworkId: 'foundry',
      sourcePath: 'src/VersionedBox.sol', contractName: 'VersionedBox', artifactPath: 'out/VersionedBox.sol/VersionedBox.json',
      artifactHash: completed.inputs.box.artifactHash,
    }]);
    expect(document.requiredPlugins).toEqual([{ id: 'foundry', version: '1.0.0' }]);
    expect(document.outputs).toEqual({ hooks: [] });
    const adopted = JSON.parse(await fs.readFile(path.join(target, 'ignite', 'deployments', WORKFLOW, `${completed.id}.json`), 'utf8'));
    expect(adopted).toMatchObject({ runId: completed.id, status: 'completed' });

    const pins = new PinnedStore();
    await pins.approveOrigins(PROFILE, [origin]);
    const repos = RepoService.getInstance();
    const jobs = JobManager.getInstance();
    const workflowHandlers = createWorkflowHandlers({
      repos, devMode: () => true, jobs, pinnedStore: pins, getProfileId: async () => PROFILE,
      lifecycle: { runPinnedLifecycle: async (url, sha, profileId) => {
        const clone = await repos.ensurePinnedClone(profileId, url, sha);
        const detected = await PluginExecutor.getInstance().execute('foundry', 'detect', {}, { workspacePath: clone.path });
        expect(detected).toMatchObject({ success: true, data: { detected: true } });
        return { pathOrUrl: clone.path, frameworks: [{ id: 'foundry', state: 'ready' }] } as never;
      } },
    });
    const resolving = reply();
    await workflowHandlers.resolveWorkflow({ body: { repoPathOrUrl: target, name: WORKFLOW } } as never, resolving);
    const job = await waitForJob(jobs, (resolving.body as { data: { jobId: string } }).data.jobId);
    expect(job).toMatchObject({ state: 'succeeded', result: { sources: [{ id: 'box', status: 'ready' }] } });

    const promotedPlan: DeploymentPlan = {
      schemaVersion: 1,
      contracts: document.sources.map((entry) => {
        if (entry.origin === 'contract-type') throw new Error('test fixture must use a repo source');
        return { id: entry.id, repoPathOrUrl: entry.repo.url, frameworkId: entry.frameworkId, sourcePath: entry.sourcePath, contractName: entry.contractName, artifactPath: entry.artifactPath, pin: structuredClone(entry.repo) };
      }),
      steps: structuredClone(document.steps) as DeploymentPlan['steps'],
      chains: [CHAIN_ID], signers: signerCascade(),
    };
    const deploymentHandlers = createDeploymentHandlers({
      engine,
      getProfileManager: async () => ({ getCurrentProfile: () => PROFILE }),
      validate: (candidate, selection, options) => validatePlan(candidate, selection, { ...options, listAccounts: async () => (await signer.listAccounts(true)).providers, captureBundles: async () => ({}) }),
    });
    const launched = reply();
    await deploymentHandlers.createDeploymentRun({ body: {
      plan: promotedPlan, rpcSelection: { [CHAIN_ID]: rpcId }, name: 'promoted rerun', idempotencyKey: crypto.randomUUID(),
      workflow: { repoPathOrUrl: target, name: WORKFLOW, hooks: [] },
    } } as never, launched);
    expect(launched.statusCode).toBe(200);
    const rerun = await waitForRun(
      (launched.body as { data: { run: RunRecord } }).data.run.id,
      (run) => run.status === 'completed' && run.repoArtifact?.status === 'written',
    );
    expect(rerun.lanes[String(CHAIN_ID)].steps[0].address).toBeTruthy();
    expect(rerun.inputs.box.artifactHash).toBe(completed.inputs.box.artifactHash);
    expect(await exists(path.join(target, 'ignite', 'deployments', WORKFLOW, `${rerun.id}.json`))).toBe(true);
  }, 300_000);

  async function waitForRun(id: string, predicate: (run: RunRecord) => boolean): Promise<RunRecord> {
    const deadline = Date.now() + 180_000;
    let last: RunRecord | undefined;
    while (Date.now() < deadline) {
      last = await engine.get(PROFILE, id);
      if (last && predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timed out waiting for run: ${JSON.stringify(last)}`);
  }
});

function signerCascade() { return { global: { pluginId: 'private-key', accountId: KEY_ID, address: SIGNER } }; }

async function configureSigner(): Promise<InstanceType<typeof SignerProviderService>> {
  const vault = new VaultStore({ getMasterKey: async () => Buffer.alloc(32, 11) });
  await new PluginConfigStore().setValue('private-key', 'keys', [{ id: KEY_ID, values: { label: 'promotion' } }]);
  await vault.setSecret('private-key', `keys.${KEY_ID}.private-key`, KEY);
  const executor = new PluginExecutor({ vaultStore: vault });
  const invoker = new PluginInvoker({ executeContainer: (id, operation, options, opts) => executor.execute(id, operation, options, opts) });
  return new SignerProviderService({ invoke: (id, operation, params, opts) => invoker.invoke(id, operation, params, opts) });
}

async function startAnvil(): Promise<Anvil> {
  const container = await docker.createContainer({ Image: ANVIL_IMAGE, Entrypoint: ['anvil'], Cmd: ['--host', '0.0.0.0', '--chain-id', String(CHAIN_ID)], ExposedPorts: { '8545/tcp': {} }, HostConfig: { AutoRemove: true, PortBindings: { '8545/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] } } });
  await container.start();
  const port = (await container.inspect()).NetworkSettings.Ports?.['8545/tcp']?.[0]?.HostPort;
  if (!port) throw new Error('anvil port missing');
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if (await createPublicClient({ transport: http(rpcUrl) }).getChainId() === CHAIN_ID) return { container, rpcUrl }; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('anvil did not start');
}

async function seedRpc(rpcUrl: string): Promise<string> {
  await new ChainRegistry().upsertCustomChain({ chainId: CHAIN_ID, name: 'Promotion Anvil', shortName: 'promotion-anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpc: [] });
  return (await new RpcStore().add(CHAIN_ID, { url: rpcUrl, label: 'Promotion Anvil' })).id;
}

async function initGit(directory: string, message: string): Promise<void> {
  await git(directory, ['init']);
  await git(directory, ['config', 'user.email', 'promotion@example.test']);
  await git(directory, ['config', 'user.name', 'Promotion Fixture']);
  await git(directory, ['add', '-A']);
  await git(directory, ['commit', '-m', message]);
}

async function git(cwd: string, args: string[]): Promise<string> { return (await exec('git', args, { cwd })).stdout; }

async function waitForJob(jobs: InstanceType<typeof JobManager>, id: string): Promise<JobRecord> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

async function exists(file: string): Promise<boolean> { try { await fs.stat(file); return true; } catch { return false; } }

function reply() {
  const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
  return value as FastifyReply & typeof value;
}
