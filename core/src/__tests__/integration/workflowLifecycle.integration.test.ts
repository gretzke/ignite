// End-to-end proof for the installed-workflow lifecycle. This suite uses a
// listening Fastify server so every action below crosses the public HTTP API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Docker from 'dockerode';
import fastify, { type FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { DeploymentPlan, JobRecord, WorkflowDocument } from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';

const exec = promisify(execFile);
const docker = new Docker();
const FOUNDRY_IMAGE = 'ignite/compiler_foundry:latest';
const PORT = 1501;
const PROFILE = 'default';
const SECOND_PROFILE = 'workflow-second-profile';
const WORKFLOW = 'release';
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflow-lifecycle-'));
FileSystem.getInstance(HOME);

const { RepoService } = await import('../../repos/RepoService.js');
const { RepoLifecycle } = await import('../../repos/RepoLifecycle.js');
const { VersionStore, canonicalGitUrl } = await import('../../repos/VersionStore.js');
const { WorkflowInstallService } = await import('../../workflows/WorkflowInstallService.js');
const { InstalledWorkflowStore } = await import('../../workflows/InstalledWorkflowStore.js');
const { JobManager } = await import('../../jobs/JobManager.js');
const { ProfileManager } = await import('../../filesystem/ProfileManager.js');
const { createProfileHandlers } = await import('../../api/profiles.js');
const { createWorkflowHandlers } = await import('../../api/workflows.js');
const { createWorkflowPromotionHandlers } = await import('../../api/workflowPromotion.js');
const { createCompilerHandlers } = await import('../../api/plugins/compiler/index.js');
const { createDeploymentHandlers } = await import('../../api/deployments.js');
const { createJobsHandlers } = await import('../../api/jobs.js');
const { validatePlan } = await import('../../deployments/validation.js');

type Remote = { url: string; source: string; v1: string; v2: string };

let ready = false;
try {
  await docker.ping();
  await docker.getImage(FOUNDRY_IMAGE).inspect();
  ready = true;
} catch {
  /* Docker-gated */
}

describe.skipIf(!ready)('workflow lifecycle integration (HTTP, offline fixture)', () => {
  let temp: string;
  let remote: Remote;
  let submoduleRemote: Remote;
  let host: string;
  let submoduleHost: string;
  let removalHost: string;
  let app: FastifyInstance;
  let installService: InstanceType<typeof WorkflowInstallService>;
  let releaseGate: (() => void) | undefined;
  let gateInstalls = false;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    await ProfileManager.getInstance();
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-workflow-lifecycle-fixture-'));
    remote = await makeRemote(temp, 'source');
    submoduleRemote = await makeSubmoduleRemote(temp);
    host = await makeHost(temp, 'host');
    submoduleHost = await makeHost(temp, 'submodule-host');
    removalHost = await makeHost(temp, 'removal-host');

    const repos = RepoService.getInstance();
    const versions = new VersionStore();
    const lifecycle = RepoLifecycle.getInstance();
    installService = WorkflowInstallService.create({
      lifecycle: {
        runPinnedLifecycle: async (...args: Parameters<typeof lifecycle.runPinnedLifecycle>) => {
          if (gateInstalls) await new Promise<void>((resolve) => { releaseGate = resolve; });
          return lifecycle.runPinnedLifecycle(...args);
        },
      },
    });
    const profiles = createProfileHandlers({ workflowInstall: installService });
    const workflows = createWorkflowHandlers({
      repos,
      devMode: () => true,
      versionStore: versions,
      installService,
    });
    const deployments = createDeploymentHandlers({
      engine: {
        launch: async (input: Record<string, unknown>) => ({ id: crypto.randomUUID(), ...input }),
        resolveLane: async () => { throw new Error('not used'); },
        resume: async () => { throw new Error('not used'); },
        abort: async () => { throw new Error('not used'); },
      } as never,
      validate: validatePlan,
    });
    const jobs = createJobsHandlers();
    const compiler = createCompilerHandlers();
    const promotion = createWorkflowPromotionHandlers();
    app = fastify();
    app.post('/api/v1/profiles', profiles.createProfile);
    app.post('/api/v1/profiles/:id/switch', profiles.switchProfile);
    app.put('/api/v1/profiles/:id/repos', profiles.saveRepo);
    app.delete('/api/v1/profiles/:id/repos', profiles.deleteRepo);
    app.get('/api/v1/jobs/:jobId', jobs.getJob);
    app.get('/api/v1/repos/workflows/status', workflows.getWorkflowsStatus);
    app.get('/api/v1/repos/workflows/:name', workflows.getWorkflow);
    app.post('/api/v1/workflows/install', workflows.installWorkflow);
    app.post('/api/v1/workflows/approve-origins', workflows.approveWorkflowOrigins);
    app.post('/api/v1/workflows/promote', promotion.promoteWorkflow);
    app.post('/api/v1/artifacts/data', compiler.getArtifactData);
    app.post('/api/v1/deployments/validate', deployments.validateDeployment);
    app.post('/api/v1/deployments/runs', deployments.createDeploymentRun);
    await app.listen({ port: PORT, host: '127.0.0.1' });
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => {});
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    delete process.env.NODE_ENV;
  });

  it('promotes, installs, fences drift, shares cache memberships, and sweeps stale state', async () => {
    await registerHost(PROFILE, host);
    await approve(PROFILE, remote.url);
    const initialHash = await promote(host, remote, remote.v1);
    expect((await status(host)).installState).toBe('not-installed');

    await install(host, initialHash);
    expect((await status(host)).installState).toBe('ready');
    const installed = new InstalledWorkflowStore();
    expect(await installed.get(PROFILE, host, WORKFLOW)).toMatchObject({
      installed: { docHash: initialHash },
    });
    const versions = new VersionStore();
    const checkout = versions.checkoutPath(remote.url, remote.v1);
    expect(await fs.stat(checkout)).toBeTruthy();
    expect((await versions.listMemberships(PROFILE))[canonicalGitUrl(remote.url)]).toEqual([
      expect.objectContaining({ commit: remote.v1, source: 'workflow' }),
    ]);

    const plan = deploymentPlan(remote, remote.v1);
    const binding = { repoPathOrUrl: host, name: WORKFLOW, hooks: [] };
    await request('POST', '/api/v1/deployments/validate', { plan, rpcSelection: {}, workflow: binding });
    await request('POST', '/api/v1/deployments/runs', { plan, rpcSelection: {}, workflow: binding, name: 'bound run', idempotencyKey: crypto.randomUUID() });

    const freshHash = await bumpPin(host, remote, remote.v2);
    const stale = await request('POST', '/api/v1/workflows/install', {
      repoPathOrUrl: host, name: WORKFLOW, expectedDocHash: initialHash,
    }, 409);
    expect(stale).toMatchObject({ code: 'WORKFLOW_DOC_CHANGED' });
    const outOfSync = await status(host);
    expect(outOfSync).toMatchObject({ installState: 'out-of-sync' });
    expect(outOfSync.diff?.versionsChanged).toEqual([
      expect.objectContaining({ from: expect.objectContaining({ commit: remote.v1 }), to: expect.objectContaining({ commit: remote.v2 }) }),
    ]);
    const blocked = await request('POST', '/api/v1/deployments/runs', {
      plan, rpcSelection: {}, workflow: binding, name: 'stale run', idempotencyKey: crypto.randomUUID(),
    }, 409);
    expect(blocked).toMatchObject({ code: 'WORKFLOW_OUT_OF_SYNC' });

    await install(host, freshHash);
    expect((await status(host)).installState).toBe('ready');
    await expect(fs.access(checkout)).rejects.toThrow();
    expect((await versions.listMemberships(PROFILE))[canonicalGitUrl(remote.url)]).toEqual([
      expect.objectContaining({ commit: remote.v2, source: 'workflow' }),
    ]);

    const created = await request<{ data: { profile: { id: string } } }>('POST', '/api/v1/profiles', { name: SECOND_PROFILE });
    const secondProfile = created.data.profile.id;
    await request('POST', `/api/v1/profiles/${secondProfile}/switch`);
    await registerHost(secondProfile, host);
    await approve(secondProfile, remote.url);
    await install(host, freshHash);
    const sharedCheckout = versions.checkoutPath(remote.url, remote.v2);
    expect(await fs.stat(sharedCheckout)).toBeTruthy();
    expect((await versions.listMemberships(secondProfile))[canonicalGitUrl(remote.url)]).toEqual([
      expect.objectContaining({ commit: remote.v2, source: 'workflow' }),
    ]);

    await request('POST', `/api/v1/profiles/${PROFILE}/switch`);
    await request('DELETE', `/api/v1/profiles/${PROFILE}/repos?pathOrUrl=${encodeURIComponent(host)}`, undefined, 204);
    await expect(fs.stat(sharedCheckout)).resolves.toBeTruthy();
    expect((await versions.listMemberships(secondProfile))[canonicalGitUrl(remote.url)]).toEqual([
      expect.objectContaining({ commit: remote.v2, source: 'workflow' }),
    ]);
  }, 300_000);

  it('materializes submodules before serving a pinned artifact', async () => {
    const profileManager = await ProfileManager.getInstance();
    const profile = profileManager.getCurrentProfile();
    await registerHost(profile, submoduleHost);
    await approve(profile, submoduleRemote.url);
    const hash = await promote(submoduleHost, submoduleRemote, submoduleRemote.v1);
    await install(submoduleHost, hash);
    const artifact = await request<{ data: { creationCode: string } }>('POST', '/api/v1/artifacts/data', {
      pathOrUrl: submoduleRemote.url,
      pluginId: 'foundry',
      artifactPath: 'out/SubmoduleConsumer.sol/SubmoduleConsumer.json',
      pin: { url: submoduleRemote.url, commit: submoduleRemote.v1, ref: 'v1.0.0', refKind: 'tag' },
    });
    expect(artifact.data.creationCode).toMatch(/^0x[0-9a-f]+$/i);
  }, 180_000);

  it('does not resurrect an install after its host repository is removed', async () => {
    const profileManager = await ProfileManager.getInstance();
    const profile = profileManager.getCurrentProfile();
    await registerHost(profile, removalHost);
    await approve(profile, remote.url);
    const hash = await promote(removalHost, remote, remote.v2);
    gateInstalls = true;
    releaseGate = undefined;
    const started = await request<{ data: { jobId: string } }>('POST', '/api/v1/workflows/install', {
      repoPathOrUrl: removalHost, name: WORKFLOW, expectedDocHash: hash,
    });
    await waitFor(() => Boolean(releaseGate));
    await request('DELETE', `/api/v1/profiles/${profile}/repos?pathOrUrl=${encodeURIComponent(removalHost)}`, undefined, 204);
    releaseInstallGate();
    releaseGate = undefined;
    gateInstalls = false;
    const job = await waitForJob(started.data.jobId);
    expect(job.state).toBe('failed');
    expect(job.error).toMatchObject({ code: 'REPO_NOT_FOUND' });
    const records = new InstalledWorkflowStore();
    await waitFor(async () => {
      expect(await records.get(profile, removalHost, WORKFLOW)).toBeUndefined();
      return true;
    });
  }, 180_000);

  async function registerHost(profile: string, repo: string): Promise<void> {
    await request('PUT', `/api/v1/profiles/${profile}/repos`, { pathOrUrl: repo });
  }

  async function approve(profile: string, url: string): Promise<void> {
    if ((await ProfileManager.getInstance()).getCurrentProfile() !== profile)
      await request('POST', `/api/v1/profiles/${profile}/switch`);
    await request('POST', '/api/v1/workflows/approve-origins', { origins: [url] });
  }

  async function promote(target: string, source: Remote, commit: string): Promise<string> {
    const plan = deploymentPlan(source, commit);
    const preview = await request<{ data: { previewId: string } }>('POST', '/api/v1/workflows/promote', {
      mode: 'preview', target: { repoPathOrUrl: target, name: WORKFLOW }, plan,
    });
    const applied = await request<{ data: { docHash: string } }>('POST', '/api/v1/workflows/promote', {
      mode: 'apply', previewId: preview.data.previewId, target: { repoPathOrUrl: target, name: WORKFLOW }, plan, hooks: [],
    });
    return applied.data.docHash;
  }

  async function install(repo: string, expectedDocHash: string): Promise<void> {
    const started = await request<{ data: { jobId: string } }>('POST', '/api/v1/workflows/install', {
      repoPathOrUrl: repo, name: WORKFLOW, expectedDocHash,
    });
    const job = await waitForJob(started.data.jobId);
    expect(job.state, JSON.stringify(job)).toBe('succeeded');
  }

  async function status(repo: string): Promise<{ installState?: string; diff?: { versionsChanged: unknown[] } }> {
    const response = await request<{ data: { workflows: Array<{ installState?: string; diff?: { versionsChanged: unknown[] } }> } }>('GET', `/api/v1/repos/workflows/status?pathOrUrl=${encodeURIComponent(repo)}`);
    return response.data.workflows[0]!;
  }

  async function bumpPin(repo: string, source: Remote, commit: string): Promise<string> {
    const file = path.join(repo, 'ignite', 'workflows', `${WORKFLOW}.json`);
    const document = JSON.parse(await fs.readFile(file, 'utf8')) as WorkflowDocument;
    const pinned = document.sources[0];
    if (pinned.origin === 'contract-type') throw new Error('fixture must have a repository source');
    pinned.repo = { ...pinned.repo, commit, ref: 'v2.0.0', refKind: 'tag' };
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    await fs.writeFile(file, raw);
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  async function request<T = unknown>(method: string, pathname: string, body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(expected);
    return text ? JSON.parse(text) as T : undefined as T;
  }

  async function waitForJob(id: string): Promise<JobRecord> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const response = await request<{ data: { job: JobRecord } }>('GET', `/api/v1/jobs/${id}`);
      if (['succeeded', 'failed', 'cancelled'].includes(response.data.job.state)) return response.data.job;
      await pause(100);
    }
    throw new Error(`Timed out waiting for job ${id}`);
  }

  function releaseInstallGate(): void {
    releaseGate?.();
  }
});

function deploymentPlan(remote: Remote, commit: string): DeploymentPlan {
  return {
    schemaVersion: 1,
    contracts: [{
      id: 'box', repoPathOrUrl: remote.url, frameworkId: 'foundry', sourcePath: 'src/Box.sol',
      contractName: 'Box', artifactPath: 'out/Box.sol/Box.json',
      pin: { url: remote.url, commit, ref: commit === remote.v1 ? 'v1.0.0' : 'v2.0.0', refKind: 'tag' },
    }],
    steps: [{ id: 'deploy', kind: 'deploy', contractId: 'box' }],
    chains: [31337], signers: {},
  };
}

async function makeHost(root: string, name: string): Promise<string> {
  const host = path.join(root, name);
  await fs.mkdir(host, { recursive: true });
  await git(host, ['init']);
  await git(host, ['config', 'user.email', 'workflow@example.test']);
  await git(host, ['config', 'user.name', 'Workflow Fixture']);
  await fs.writeFile(path.join(host, 'README.md'), '# workflow host\n');
  await git(host, ['add', '-A']);
  await git(host, ['commit', '-m', 'host']);
  return host;
}

async function makeRemote(root: string, name: string): Promise<Remote> {
  const source = path.join(root, name);
  const bare = path.join(root, `${name}.git`);
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'foundry.toml'), '[profile.default]\nsolc = "0.8.30"\n');
  await writeBox(source, 1);
  await git(source, ['init']);
  await git(source, ['config', 'user.email', 'workflow@example.test']);
  await git(source, ['config', 'user.name', 'Workflow Fixture']);
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'Box v1']);
  await git(source, ['tag', 'v1.0.0']);
  const v1 = (await git(source, ['rev-parse', 'HEAD'])).trim();
  await writeBox(source, 2);
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'Box v2']);
  await git(source, ['tag', 'v2.0.0']);
  const v2 = (await git(source, ['rev-parse', 'HEAD'])).trim();
  await exec('git', ['clone', '--bare', source, bare]);
  return { url: pathToFileURL(bare).href, source, v1, v2 };
}

async function makeSubmoduleRemote(root: string): Promise<Remote> {
  const dependency = path.join(root, 'dependency');
  await fs.mkdir(path.join(dependency, 'src'), { recursive: true });
  await fs.writeFile(path.join(dependency, 'src', 'Dependency.sol'), '// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\nlibrary Dependency { function value() internal pure returns (uint256) { return 7; } }\n');
  await git(dependency, ['init']);
  await git(dependency, ['config', 'user.email', 'workflow@example.test']);
  await git(dependency, ['config', 'user.name', 'Workflow Fixture']);
  await git(dependency, ['add', '-A']);
  await git(dependency, ['commit', '-m', 'dependency']);
  const dependencyBare = path.join(root, 'dependency.git');
  await exec('git', ['clone', '--bare', dependency, dependencyBare]);

  const source = path.join(root, 'submodule-source');
  const bare = path.join(root, 'submodule-source.git');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'foundry.toml'), '[profile.default]\nsolc = "0.8.30"\nlibs = ["lib"]\n');
  await writeBox(source, 1);
  await fs.writeFile(path.join(source, 'src', 'SubmoduleConsumer.sol'), '// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\nimport {Dependency} from "dependency/Dependency.sol";\ncontract SubmoduleConsumer { function value() external pure returns (uint256) { return Dependency.value(); } }\n');
  await git(source, ['init']);
  await git(source, ['config', 'user.email', 'workflow@example.test']);
  await git(source, ['config', 'user.name', 'Workflow Fixture']);
  await git(source, ['-c', 'protocol.file.allow=always', 'submodule', 'add', pathToFileURL(dependencyBare).href, 'lib/dependency']);
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'submodule consumer']);
  await git(source, ['tag', 'v1.0.0']);
  const v1 = (await git(source, ['rev-parse', 'HEAD'])).trim();
  await exec('git', ['clone', '--bare', source, bare]);
  return { url: pathToFileURL(bare).href, source, v1, v2: v1 };
}

async function writeBox(source: string, version: number): Promise<void> {
  await fs.writeFile(path.join(source, 'src', 'Box.sol'), `// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\ncontract Box { function version() external pure returns (uint256) { return ${version}; } }\n`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause(25);
  }
  throw new Error('Timed out waiting for condition');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
