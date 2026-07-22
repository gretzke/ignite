// D6 workflow integration proofs. The mandatory leg is deliberately offline:
// fixture artifacts are checked in and the real Foundry plugin only detects
// and reads them. The opt-in leg is the sole test that invokes forge build.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import fastify from 'fastify';
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
const CHAIN_ID = 31337;
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const FOUNDRY_IMAGE = 'ignite/compiler_foundry:latest';
const PRIVATE_KEY_IMAGE = 'ignite/signer-provider_private-key:latest';
const SHARED_IMAGE = 'ignite/shared:latest';
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SIGNER = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const HISTORICAL = getAddress('0x1111111111111111111111111111111111111111');
const PROFILE = 'workflow-integration';
const WORKFLOW = 'versioned-release';
const PRIVATE_KEY_PLUGIN = 'private-key';
const KEY_ID = 'workflowkey';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_V1 = path.join(HERE, 'fixtures', 'workflow-repo-v1');
const FIXTURE_V2 = path.join(HERE, 'fixtures', 'workflow-repo-v2');
const PLUGINS_DIR = path.resolve(HERE, '../../../../plugins');
const CHRONICLES_DIR = path.join(PLUGINS_DIR, 'ecosystem', 'chronicles-logger');
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflow-integration-'));
FileSystem.getInstance(HOME);

const { ChainRegistry } = await import('../../chains/ChainRegistry.js');
const { RpcStore } = await import('../../chains/RpcStore.js');
const { DeployEngine } = await import('../../deployments/DeployEngine.js');
const { validatePlan } = await import('../../deployments/validation.js');
const { renderArtifact } = await import('../../deployments/artifact.js');
const { createDeploymentHandlers } = await import('../../api/deployments.js');
const { createWorkflowHandlers } = await import('../../api/workflows.js');
const { createWorkflowPromotionHandlers } = await import('../../api/workflowPromotion.js');
const { createProfileHandlers } = await import('../../api/profiles.js');
const { createPointerSuggestionHandlers } = await import('../../api/pointerSuggestions.js');
const { SignerProviderService } = await import('../../signers/SignerProviderService.js');
const { VaultStore } = await import('../../plugins/vault/VaultStore.js');
const { PluginConfigStore } = await import('../../plugins/config/PluginConfigStore.js');
const { PluginExecutor } = await import('../../plugins/containers/PluginExecutor.js');
const { PluginInvoker } = await import('../../plugins/invoke/PluginInvoker.js');
const { PluginInstaller } = await import('../../plugins/install/PluginInstaller.js');
const { LocalFolderBuildBackend } = await import('../../plugins/install/LocalFolderBuildBackend.js');
const { TrustManager } = await import('../../plugins/trust/TrustManager.js');
const { RepoService } = await import('../../repos/RepoService.js');
const { VersionStore, canonicalGitUrl, pinnedOrigin } = await import('../../repos/VersionStore.js');
const { WorkflowPromotionService } = await import('../../workflows/WorkflowPromotionService.js');
const { JobManager } = await import('../../jobs/JobManager.js');
const { DeploymentHookService } = await import('../../deployments/DeploymentHookService.js');
const { PointerSuggestionService } = await import('../../deployments/PointerSuggestionService.js');

type Anvil = { container: Docker.Container; rpcUrl: string };
type FixtureRemote = { url: string; v1: string; v2: string };
let ready = false;
try {
  await docker.ping();
  for (const image of [ANVIL_IMAGE, FOUNDRY_IMAGE, PRIVATE_KEY_IMAGE, SHARED_IMAGE]) await docker.getImage(image).inspect();
  ready = true;
} catch { /* suite is Docker-gated */ }

describe.skipIf(!ready)('workflow integration (offline pins, run, chronicles, suggestions)', () => {
  let temp: string;
  let workspace: string;
  let remote: FixtureRemote;
  let document: WorkflowDocument;
  let anvil: Anvil;
  let rpcId: string;
  let signer: InstanceType<typeof SignerProviderService>;
  let engine: InstanceType<typeof DeployEngine>;
  let installer: InstanceType<typeof PluginInstaller>;
  let firstRun: RunRecord;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflow-fixtures-'));
    remote = await makeVersionedRemote(temp);
    workspace = path.join(temp, 'workspace');
    await fs.mkdir(path.join(workspace, 'ignite', 'workflows'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'deployments', 'json'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'deployments', 'json', `${CHAIN_ID}.json`), `${JSON.stringify(historicalLog(), null, 2)}\n`);
    await fs.writeFile(path.join(workspace, 'deployments', `${CHAIN_ID}.md`), 'Human release notes stay here.\n');
    document = workflowDocument(remote);
    await fs.writeFile(path.join(workspace, 'ignite', 'workflows', `${WORKFLOW}.json`), `${JSON.stringify(document, null, 2)}\n`);
    await initGit(workspace);

    installer = new PluginInstaller(new LocalFolderBuildBackend());
    await installer.install({ kind: 'local', contextDir: CHRONICLES_DIR });
    await TrustManager.getInstance().setTrust('chronicles-logger', 'trusted', { repoWrite: true, net: false, secrets: [] });
    DeploymentHookService.resetInstance();

    signer = await configureSigner();
    anvil = await startAnvil();
    rpcId = await seedRpc(anvil.rpcUrl);
    engine = new DeployEngine({
      executeTx: signer.executeTx.bind(signer),
      resolveAccount: signer.resolveAccount.bind(signer),
      validate: (plan, selection, options) => validatePlan(plan, selection, {
        ...options,
        listAccounts: async () => (await signer.listAccounts(true)).providers,
        captureBundles: async () => ({}),
      }),
      chainMetadata: async (chainId) => ({ chainId, name: `Anvil ${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }),
      deploymentHooks: DeploymentHookService.getInstance(),
    });
  }, 300_000);

  afterAll(async () => {
    await engine?.shutdown().catch(() => {});
    await anvil?.container.stop({ t: 2 }).catch(() => {});
    await installer?.uninstall('chronicles-logger').catch(() => {});
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    delete process.env.NODE_ENV;
  });

  it('describes the repo-reading Chronicles hook through the real executor without a workspace bind', async () => {
    await expect(DeploymentHookService.getInstance().list(true)).resolves.toContainEqual(expect.objectContaining({ pluginId: 'chronicles-logger' }));
  }, 60_000);

  it('blocks unapproved origins, rejects ssh pins, and resolves both tags through real Foundry detect', async () => {
    const repos = RepoService.getInstance();
    const pins = new VersionStore();
    const jobs = JobManager.getInstance();
    const handlers = createWorkflowHandlers({
      repos,
      devMode: () => true,
      jobs,
      versionStore: pins,
      getProfileId: async () => PROFILE,
      registry: { list: async () => ({ session: null, local: [{ pathOrUrl: workspace }], cloned: [] }) } as never,
      lifecycle: {
        runPinnedLifecycle: async (url, commit, profileId) => {
          const clone = await repos.ensureVersion(profileId, url, commit);
          const detected = await PluginExecutor.getInstance().execute('foundry', 'detect', {}, { workspacePath: clone.checkout });
          expect(detected).toMatchObject({ success: true, data: { detected: true } });
          return { pathOrUrl: clone.checkout, frameworks: [{ id: 'foundry', state: 'ready' }] } as never;
        },
      },
    });

    const blocked = reply();
    await handlers.installWorkflow({ body: { repoPathOrUrl: workspace, name: WORKFLOW, expectedDocHash: await workflowHash(workspace, WORKFLOW) } } as never, blocked);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'PINNED_ORIGIN_UNAPPROVED', details: { origins: [pinnedOrigin(remote.url)] } });

    const ssh = structuredClone(document) as WorkflowDocument;
    const sshSource = ssh.sources[0];
    if (sshSource.origin === 'contract-type') throw new Error('test fixture must use a repo source');
    sshSource.repo.url = 'ssh://git@example.test/repo.git';
    const invalid = reply();
    await handlers.putWorkflow({ params: { name: 'ssh-pin' }, query: { pathOrUrl: workspace }, body: { document: ssh } } as never, invalid);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'WORKFLOW_INVALID' });

    await pins.approveOrigins(PROFILE, [remote.url]);
    const started = reply();
    await handlers.installWorkflow({ body: { repoPathOrUrl: workspace, name: WORKFLOW, expectedDocHash: await workflowHash(workspace, WORKFLOW) } } as never, started);
    expect(started.statusCode).toBe(200);
    const job = await waitForJob(jobs, (started.body as { data: { jobId: string } }).data.jobId);
    expect(job.state).toBe('succeeded');
    expect(job.result).toMatchObject({ sources: [{ id: 'box-v1', status: 'ready' }, { id: 'box-v2', status: 'ready' }, { id: 'consumer', status: 'ready' }] });

    const v1Path = pins.checkoutPath(remote.url, remote.v1);
    const v2Path = pins.checkoutPath(remote.url, remote.v2);
    expect(await fs.stat(v1Path)).toBeTruthy();
    expect(await fs.stat(v2Path)).toBeTruthy();
    expect(v1Path).not.toBe(v2Path);

    await fs.writeFile(path.join(v1Path, 'src', 'VersionedBox.sol'), '// hostile tracked mutation\n');
    await repos.ensureVersion(PROFILE, remote.url, remote.v1);
    expect(await fs.readFile(path.join(v1Path, 'src', 'VersionedBox.sol'), 'utf8')).toContain('contract VersionedBox');
  }, 180_000);

  it('retains workflow versions across promotion, cache eviction, resolution, deletion, and reconciliation', async () => {
    const retentionRoot = path.join(temp, 'retention');
    await fs.mkdir(retentionRoot, { recursive: true });
    const retentionRemote = await makeVersionedRemote(retentionRoot);
    const pins = new VersionStore();
    const repos = RepoService.getInstance();
    const jobs = JobManager.getInstance();
    const name = 'retention-release';
    const plan: DeploymentPlan = {
      schemaVersion: 1,
      chains: [CHAIN_ID],
      signers: {},
      contracts: [{
        id: 'draft-box', repoPathOrUrl: retentionRemote.url, frameworkId: 'foundry', sourcePath: 'src/VersionedBox.sol',
        contractName: 'VersionedBox', artifactPath: 'out/VersionedBox.sol/VersionedBox.json',
        pin: { url: retentionRemote.url, commit: retentionRemote.v1, ref: 'v1.0.0', refKind: 'tag' },
      }],
      steps: [{ id: 'deploy', kind: 'deploy', contractId: 'draft-box' }],
    };
    await pins.approveOrigins(PROFILE, [retentionRemote.url]);
    await repos.ensureVersion(PROFILE, retentionRemote.url, retentionRemote.v1);
    await pins.addMembership(PROFILE, retentionRemote.url, retentionRemote.v1, 'user');

    const promotions = new WorkflowPromotionService({ getRequiredPlugin: async (id) => ({ id, version: '1.0.0' }) });
    const promotionHandlers = createWorkflowPromotionHandlers(promotions, { check: async () => ({ sources: [], plugins: [] }) } as never, async () => PROFILE);
    const previewReply = reply();
    await promotionHandlers.promoteWorkflow({ body: { mode: 'preview', target: { repoPathOrUrl: workspace, name }, plan } } as never, previewReply);
    const previewId = (previewReply.body as { data: { previewId: string } }).data.previewId;
    const applyReply = reply();
    await promotionHandlers.promoteWorkflow({ body: { mode: 'apply', previewId, target: { repoPathOrUrl: workspace, name }, plan, hooks: [] } } as never, applyReply);
    expect(applyReply.statusCode).toBe(200);

    const profileHandlers = createProfileHandlers({ repos, versionStore: pins, lifecycle: { activeJobFor: () => undefined } as never });
    const wipeReply = reply();
    await profileHandlers.removeRepoVersion({ params: { id: PROFILE }, body: { url: retentionRemote.url, commit: retentionRemote.v1 } } as never, wipeReply);
    expect(wipeReply.statusCode).toBe(204);
    await expect(fs.access(pins.checkoutPath(retentionRemote.url, retentionRemote.v1))).rejects.toThrow();

    const workflowHandlers = createWorkflowHandlers({
      repos,
      devMode: () => true,
      jobs,
      versionStore: pins,
      getProfileId: async () => PROFILE,
      registry: { list: async () => ({ session: null, local: [{ pathOrUrl: workspace }], cloned: [] }) } as never,
      lifecycle: { runPinnedLifecycle: async (url, commit, profileId) => {
        const clone = await repos.ensureVersion(profileId, url, commit);
        return { pathOrUrl: clone.checkout, frameworks: [{ id: 'foundry', state: 'ready' }] } as never;
      } },
      artifactReadable: async () => true,
      pluginStatus: async (id, requiredVersion) => ({ id, status: 'installed', installedVersion: requiredVersion }),
    });
    const installReply = reply();
    await workflowHandlers.installWorkflow({ body: { repoPathOrUrl: workspace, name, expectedDocHash: await workflowHash(workspace, name) } } as never, installReply);
    const resolved = await waitForJob(jobs, (installReply.body as { data: { jobId: string } }).data.jobId);
    expect(resolved).toMatchObject({ state: 'succeeded', result: { sources: [{ status: 'ready' }] } });
    expect(await fs.stat(pins.checkoutPath(retentionRemote.url, retentionRemote.v1))).toBeTruthy();
    expect((await pins.listMemberships(PROFILE))[canonicalGitUrl(retentionRemote.url)]).toEqual([
      expect.objectContaining({ commit: retentionRemote.v1, source: 'workflow' }),
    ]);

    const retainedDelete = reply();
    await profileHandlers.removeRepoVersion({ params: { id: PROFILE }, body: { url: retentionRemote.url, commit: retentionRemote.v1 } } as never, retainedDelete);
    expect(retainedDelete.statusCode).toBe(204);
    expect((await pins.listMemberships(PROFILE))[canonicalGitUrl(retentionRemote.url)]).toEqual([
      expect.objectContaining({ commit: retentionRemote.v1, source: 'workflow' }),
    ]);
    await expect(fs.stat(pins.checkoutPath(retentionRemote.url, retentionRemote.v1))).resolves.toBeTruthy();

    await fs.rm(path.join(workspace, 'ignite', 'workflows', `${name}.json`));
    await fs.rm(pins.checkoutPath(retentionRemote.url, retentionRemote.v1), { recursive: true, force: true });
    await pins.reconcile();
    expect(await pins.get(retentionRemote.url, retentionRemote.v1)).toBeUndefined();
    expect((await pins.listMemberships(PROFILE))[canonicalGitUrl(retentionRemote.url)]).toBeUndefined();
  }, 180_000);

  it('deploys both versions and a pointer, copies the artifact, and delivers chronicles idempotently', async () => {
    const plan = deploymentPlan(document, SIGNER);
    const handlers = createDeploymentHandlers({
      engine,
      getProfileManager: async () => ({ getCurrentProfile: () => PROFILE }),
      validate: (candidate, selection, options) => validatePlan(candidate, selection, {
        ...options,
        listAccounts: async () => (await signer.listAccounts(true)).providers,
        captureBundles: async () => ({}),
      }),
    });
    const launched = reply();
    await handlers.createDeploymentRun({ body: {
      plan,
      rpcSelection: { [CHAIN_ID]: rpcId },
      name: 'workflow first run',
      idempotencyKey: crypto.randomUUID(),
      workflow: { repoPathOrUrl: workspace, name: WORKFLOW, hooks: ['chronicles-logger'] },
    } } as never, launched);
    expect(launched.statusCode).toBe(200);
    firstRun = await waitForRun(engine, (launched.body as { data: { run: RunRecord } }).data.run.id, (run) => run.status === 'completed' && run.hookRuns?.['chronicles-logger']?.status === 'completed');

    const lane = firstRun.lanes[String(CHAIN_ID)];
    expect(lane.steps.map((step) => step.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    const v1 = lane.steps.find((step) => step.stepId === 'deploy-v1')!;
    const v2 = lane.steps.find((step) => step.stepId === 'deploy-v2')!;
    const consumer = lane.steps.find((step) => step.stepId === 'consumer')!;
    expect(v1.address).not.toBe(v2.address);
    expect((await readTarget(anvil.rpcUrl, consumer.address!)).toLowerCase()).toBe(v2.address!.toLowerCase());

    const artifactFile = path.join(workspace, 'ignite', 'deployments', WORKFLOW, `${firstRun.id}.json`);
    const artifact = JSON.parse(await fs.readFile(artifactFile, 'utf8'));
    expect(artifact.workflow).toMatchObject({ name: WORKFLOW });
    expect(artifact.contracts.map((entry: { versionLabel?: string }) => entry.versionLabel)).toEqual(['v1.0.0', 'v2.0.0', 'v2.0.0']);

    const logFile = path.join(workspace, 'deployments', 'json', `${CHAIN_ID}.json`);
    const log = JSON.parse(await fs.readFile(logFile, 'utf8'));
    expect(log.unknownRoot).toEqual({ keep: true });
    expect(log.history.find((entry: { eventId: string }) => entry.eventId === 'historical:31337:box').unknownEntry).toBe('keep');
    expect(log.history.filter((entry: { runId: string }) => entry.runId === firstRun.id)).toHaveLength(3);
    const markdown = await fs.readFile(path.join(workspace, 'deployments', `${CHAIN_ID}.md`), 'utf8');
    expect(markdown.startsWith('Human release notes stay here.\n')).toBe(true);
    expect(markdown).toContain('<!-- ignite:chronicles:begin -->');

    await new (await import('../../deployments/RunStore.js')).RunStore().mutate(PROFILE, firstRun.id, (run) => {
      run.hookRuns!['chronicles-logger'] = { status: 'pending' };
    });
    await DeploymentHookService.getInstance().reconcileStartup();
    await waitForRun(engine, firstRun.id, (run) => run.hookRuns?.['chronicles-logger']?.status === 'completed');
    const redelivered = JSON.parse(await fs.readFile(logFile, 'utf8'));
    expect(redelivered.history.filter((entry: { runId: string }) => entry.runId === firstRun.id)).toHaveLength(3);
  }, 240_000);

  it('surfaces historical suggestions through POST and records provenance on a literal second run', async () => {
    const hookResponse = await PluginExecutor.getInstance().execute(
      'chronicles-logger',
      'suggestAddresses',
      { contractName: 'VersionedBox', chainIds: [CHAIN_ID] },
      { workspacePath: workspace, chainScope: 'none' },
    );
    expect(hookResponse).toMatchObject({ success: true });
    expect((hookResponse as { success: true; data: { suggestions: Array<{ address: string }> } }).data.suggestions.map((entry) => entry.address.toLowerCase())).toContain(HISTORICAL.toLowerCase());
    // Cold Docker startup can exceed the production fan-out budget on CI;
    // keep the same real hook path but widen only this integration harness.
    const service = new PointerSuggestionService({
      hooks: { suggest: (pluginIds, repo, request) => DeploymentHookService.getInstance().suggest(pluginIds, repo, request, 10_000) },
    });
    const app = fastify({ logger: false });
    const handlers = createPointerSuggestionHandlers(service, async () => PROFILE);
    app.post('/api/v1/deployments/pointer-suggestions', (request, response) => handlers.pointerSuggestions(request as never, response));
    const response = await app.inject({ method: 'POST', url: '/api/v1/deployments/pointer-suggestions', payload: {
      workflow: { repoPathOrUrl: workspace, name: WORKFLOW }, sourceId: 'box-v1', contractName: 'VersionedBox', chainIds: [CHAIN_ID],
    } });
    expect(response.statusCode).toBe(200);
    const suggestions = response.json().data.suggestionsByChain[String(CHAIN_ID)] as Array<{ address: string; sources: unknown[] }>;
    expect(suggestions.map((entry) => entry.address.toLowerCase())).toContain(HISTORICAL.toLowerCase());
    await app.close();

    const consumerSource = document.sources.find((source) => source.id === 'consumer')!;
    const plan: DeploymentPlan = {
      schemaVersion: 1,
      contracts: [toContract(consumerSource)],
      chains: [CHAIN_ID],
      signers: signerCascade(SIGNER),
      steps: [{ id: 'consumer-literal', kind: 'deploy', contractId: 'consumer', args: { target_: HISTORICAL } }],
    };
    const binding = {
      repoPathOrUrl: workspace, name: WORKFLOW, hooks: ['chronicles-logger'],
      resolutions: [{ stepId: 'consumer-literal', path: '/args/target_', chainId: CHAIN_ID, address: HISTORICAL, source: 'suggestion' as const, via: { kind: 'plugin' as const, pluginId: 'chronicles-logger' } }],
    };
    const handlers2 = createDeploymentHandlers({
      engine,
      getProfileManager: async () => ({ getCurrentProfile: () => PROFILE }),
      validate: (candidate, selection, options) => validatePlan(candidate, selection, { ...options, listAccounts: async () => (await signer.listAccounts(true)).providers, captureBundles: async () => ({}) }),
    });
    const launched = reply();
    await handlers2.createDeploymentRun({ body: { plan, rpcSelection: { [CHAIN_ID]: rpcId }, name: 'literal rerun', idempotencyKey: crypto.randomUUID(), workflow: binding } } as never, launched);
    expect(launched.statusCode).toBe(200);
    const complete = await waitForRun(engine, (launched.body as { data: { run: RunRecord } }).data.run.id, (run) => run.status === 'completed');
    const artifact = renderArtifact(complete);
    expect(artifact.lanes[String(CHAIN_ID)].steps[0].pointers).toContainEqual(expect.objectContaining({ path: '/args/target_', address: HISTORICAL, source: 'suggestion', via: 'plugin:chronicles-logger' }));
    expect(await readTarget(anvil.rpcUrl, complete.lanes[String(CHAIN_ID)].steps[0].address!)).toBe(HISTORICAL);
  }, 240_000);
});

describe.skipIf(!process.env.D6_NET_TESTS)('workflow integration (network-gated real compile)', () => {
  it('runs forge build in a pinned clone through the real Foundry plugin', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflow-net-'));
    try {
      const remote = await makeVersionedRemote(temp);
      const pins = new VersionStore();
      await pins.approveOrigins(PROFILE, [remote.url]);
      const clone = await RepoService.getInstance().ensureVersion(PROFILE, remote.url, remote.v2);
      await fs.rm(path.join(clone.checkout, 'out'), { recursive: true, force: true });
      const result = await PluginExecutor.getInstance().execute('foundry', 'compile', {}, { workspacePath: clone.checkout });
      expect(result).toMatchObject({ success: true });
      expect(await fs.stat(path.join(clone.checkout, 'out', 'VersionedBox.sol', 'VersionedBox.json'))).toBeTruthy();
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }, 300_000);
});

function workflowDocument(remote: FixtureRemote): WorkflowDocument {
  const source = (id: string, commit: string, ref: string, contractName: string) => ({
    id, repo: { url: remote.url, commit, ref, refKind: 'tag' as const }, frameworkId: 'foundry',
    sourcePath: `src/${contractName}.sol`, contractName, artifactPath: `out/${contractName}.sol/${contractName}.json`,
  });
  return {
    schemaVersion: 1,
    description: 'Two pinned versions and a pointer consumer',
    sources: [source('box-v1', remote.v1, 'v1.0.0', 'VersionedBox'), source('box-v2', remote.v2, 'v2.0.0', 'VersionedBox'), source('consumer', remote.v2, 'v2.0.0', 'PointerConsumer')],
    steps: [
      { id: 'deploy-v1', kind: 'deploy', contractId: 'box-v1', args: { owner_: SIGNER } },
      { id: 'deploy-v2', kind: 'deploy', contractId: 'box-v2', args: { owner_: SIGNER } },
      { id: 'consumer', kind: 'deploy', contractId: 'consumer', args: { target_: { $ref: { kind: 'step', stepId: 'deploy-v2' } } } },
    ],
    defaultChains: [CHAIN_ID],
    requiredPlugins: [{ id: 'foundry', version: '1.0.0' }, { id: 'chronicles-logger', version: '0.1.0' }],
    outputs: { hooks: ['chronicles-logger'] },
  };
}

function deploymentPlan(document: WorkflowDocument, signer: Hex): DeploymentPlan {
  return { schemaVersion: 1, contracts: document.sources.map(toContract), steps: structuredClone(document.steps) as DeploymentPlan['steps'], chains: [CHAIN_ID], signers: signerCascade(signer) };
}

function toContract(source: WorkflowDocument['sources'][number]) {
  if (source.origin === 'contract-type') throw new Error('test fixture must use a repo source');
  return { id: source.id, repoPathOrUrl: source.repo.url, frameworkId: source.frameworkId, sourcePath: source.sourcePath, contractName: source.contractName, artifactPath: source.artifactPath, pin: structuredClone(source.repo) };
}

function signerCascade(address: Hex) {
  return { global: { pluginId: PRIVATE_KEY_PLUGIN, accountId: KEY_ID, address } };
}

function historicalLog() {
  return {
    chainId: CHAIN_ID,
    unknownRoot: { keep: true },
    latest: { VersionedBox: HISTORICAL },
    history: [{ name: 'VersionedBox', address: HISTORICAL, timestamp: '2020-01-01T00:00:00.000Z', runId: 'historical', eventId: 'historical:31337:box', workflow: 'legacy', unknownEntry: 'keep' }],
  };
}

async function makeVersionedRemote(root: string): Promise<FixtureRemote> {
  const work = path.join(root, `source-${crypto.randomUUID()}`);
  const bare = path.join(root, `remote-${crypto.randomUUID()}.git`);
  await fs.cp(FIXTURE_V1, work, { recursive: true });
  await initGit(work, false);
  await git(work, ['tag', 'v1.0.0']);
  const v1 = (await git(work, ['rev-parse', 'HEAD'])).trim();
  for (const entry of await fs.readdir(work)) if (entry !== '.git') await fs.rm(path.join(work, entry), { recursive: true, force: true });
  await fs.cp(FIXTURE_V2, work, { recursive: true, force: true });
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-m', 'fixture v2']);
  await git(work, ['tag', 'v2.0.0']);
  const v2 = (await git(work, ['rev-parse', 'HEAD'])).trim();
  await exec('git', ['clone', '--bare', work, bare]);
  return { url: pathToFileURL(bare).href, v1, v2 };
}

async function initGit(directory: string, commit = true): Promise<void> {
  await git(directory, ['init']);
  await git(directory, ['config', 'user.email', 'workflow@example.test']);
  await git(directory, ['config', 'user.name', 'Workflow Fixture']);
  await git(directory, ['add', '-A']);
  await git(directory, ['commit', '-m', commit ? 'workflow fixture' : 'fixture v1']);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })).stdout;
}

async function configureSigner(): Promise<InstanceType<typeof SignerProviderService>> {
  const vault = new VaultStore({ getMasterKey: async () => Buffer.alloc(32, 9) });
  const config = new PluginConfigStore();
  await config.setValue(PRIVATE_KEY_PLUGIN, 'keys', [{ id: KEY_ID, values: { label: 'workflow' } }]);
  await vault.setSecret(PRIVATE_KEY_PLUGIN, `keys.${KEY_ID}.private-key`, KEY);
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
  await new ChainRegistry().upsertCustomChain({ chainId: CHAIN_ID, name: 'Workflow Anvil', shortName: 'workflow-anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpc: [] });
  return (await new RpcStore().add(CHAIN_ID, { url: rpcUrl, label: 'Workflow Anvil' })).id;
}

async function waitForJob(jobs: InstanceType<typeof JobManager>, id: string): Promise<JobRecord> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

async function waitForRun(engine: InstanceType<typeof DeployEngine>, id: string, predicate: (run: RunRecord) => boolean): Promise<RunRecord> {
  const deadline = Date.now() + 180_000;
  let last: RunRecord | undefined;
  while (Date.now() < deadline) {
    last = await engine.get(PROFILE, id);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for run: ${JSON.stringify(last)}`);
}

async function readTarget(rpcUrl: string, address: Hex): Promise<Hex> {
  return getAddress(await createPublicClient({ transport: http(rpcUrl) }).readContract({ address, abi: [{ type: 'function', name: 'target', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'target' }));
}

async function workflowHash(repoPathOrUrl: string, name: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(path.join(repoPathOrUrl, 'ignite', 'workflows', `${name}.json`), 'utf8')).digest('hex');
}

function reply() {
  const value = { statusCode: 0, body: undefined as unknown, status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
  return value as FastifyReply & typeof value;
}
