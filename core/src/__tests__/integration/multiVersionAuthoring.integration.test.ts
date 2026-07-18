// Headless E2E proof for the multi-version authoring headline: a single
// repository contributes two pinned releases to one deployment run. This
// deliberately drives the HTTP handlers through Fastify injection, rather
// than depending on a browser or a listening development server.
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
import { createPublicClient, getAddress, http, type Hex } from 'viem';
import type { DeploymentPlan, JobRecord, RunRecord } from '@ignite/api';
import { FileSystem } from '../../filesystem/FileSystem.js';

const exec = promisify(execFile);
const docker = new Docker();
const CHAIN_ID = 31340;
const PROFILE = 'default';
const ANVIL_IMAGE = 'ghcr.io/foundry-rs/foundry:latest';
const FOUNDRY_IMAGE = 'ignite/compiler_foundry:latest';
const PRIVATE_KEY_IMAGE = 'ignite/signer-provider_private-key:latest';
const KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const SIGNER = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const KEY_ID = 'multiversionkey';
const HOME = await fs.mkdtemp(
  path.join(os.tmpdir(), 'ignite-multi-version-e2e-')
);
FileSystem.getInstance(HOME);

const { ChainRegistry } = await import('../../chains/ChainRegistry.js');
const { RpcStore } = await import('../../chains/RpcStore.js');
const { DeployEngine } = await import('../../deployments/DeployEngine.js');
const { validatePlan } = await import('../../deployments/validation.js');
const { createProfileHandlers } = await import('../../api/profiles.js');
const { createCompilerHandlers } = await import(
  '../../api/plugins/compiler/index.js'
);
const { createDeploymentHandlers } = await import('../../api/deployments.js');
const { SignerProviderService } = await import(
  '../../signers/SignerProviderService.js'
);
const { VaultStore } = await import('../../plugins/vault/VaultStore.js');
const { PluginConfigStore } = await import(
  '../../plugins/config/PluginConfigStore.js'
);
const { PluginExecutor } = await import(
  '../../plugins/containers/PluginExecutor.js'
);
const { PluginInvoker } = await import('../../plugins/invoke/PluginInvoker.js');
const { RepoService } = await import('../../repos/RepoService.js');
const { VersionStore } = await import('../../repos/VersionStore.js');
const { JobManager } = await import('../../jobs/JobManager.js');
const { ProfileManager } = await import('../../filesystem/ProfileManager.js');

type Anvil = { container: Docker.Container; rpcUrl: string };
type FixtureRemote = { url: string; source: string; v1: string; v2: string };

let ready = false;
try {
  await docker.ping();
  for (const image of [ANVIL_IMAGE, FOUNDRY_IMAGE, PRIVATE_KEY_IMAGE]) {
    await docker.getImage(image).inspect();
  }
  ready = true;
} catch {
  /* Docker-gated */
}

describe.skipIf(!ready)(
  'multi-version authoring integration (HTTP, offline fixture)',
  () => {
    let temp: string;
    let remote: FixtureRemote;
    let app: FastifyInstance;
    let anvil: Anvil;
    let rpcId: string;
    let signer: InstanceType<typeof SignerProviderService>;
    let engine: InstanceType<typeof DeployEngine>;

    beforeAll(async () => {
      process.env.NODE_ENV = 'development';
      await ProfileManager.getInstance();
      temp = await fs.mkdtemp(
        path.join(os.tmpdir(), 'ignite-multi-version-fixture-')
      );
      remote = await makeFixtureRemote(temp);
      signer = await configureSigner();
      anvil = await startAnvil();
      rpcId = await seedRpc(anvil.rpcUrl);
      engine = new DeployEngine({
        executeTx: signer.executeTx.bind(signer),
        resolveAccount: signer.resolveAccount.bind(signer),
        validate: (plan, selection, options) =>
          validatePlan(plan, selection, {
            ...options,
            listAccounts: async () =>
              (await signer.listAccounts(true)).providers,
            captureBundles: async () => ({}),
          }),
        chainMetadata: async (chainId) => ({
          chainId,
          name: `Multi-version Anvil ${chainId}`,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        }),
      });
      app = makeApp(engine, signer);
    }, 180_000);

    afterAll(async () => {
      await app?.close().catch(() => {});
      await engine?.shutdown().catch(() => {});
      await anvil?.container.stop({ t: 2 }).catch(() => {});
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
      await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
      delete process.env.NODE_ENV;
    });

    it('adds two tags, lists a compiler variant, and deploys both pinned releases together', async () => {
      const jobs = JobManager.getInstance();
      const pins = new VersionStore();

      const registered = await request<{ data: { jobId: string } }>(
        app,
        'PUT',
        `/api/v1/profiles/${PROFILE}/repos`,
        {
          pathOrUrl: remote.source,
        }
      );
      expect((await waitForJob(jobs, registered.data.jobId)).state).toBe(
        'succeeded'
      );

      await pins.approveOrigins(PROFILE, [remote.url]);
      for (const tag of ['v1.0.0', 'v2.0.0'] as const) {
        const added = await request<{ data: { jobId: string } }>(
          app,
          'POST',
          `/api/v1/profiles/${PROFILE}/repos/versions`,
          {
            repoPathOrUrl: remote.source,
            ref: tag,
            refKind: 'tag',
          }
        );
        const job = await waitForJob(jobs, added.data.jobId);
        expect(job.state, JSON.stringify(job)).toBe('succeeded');
      }

      const repos = await request<{
        data: {
          local: Array<{
            pathOrUrl: string;
            versions: Array<{
              commit: string;
              frameworks?: Array<{ id: string }>;
            }>;
          }>;
        };
      }>(app, 'GET', `/api/v1/profiles/${PROFILE}/repos`);
      const entry = repos.data.local.find(
        (repo) => repo.pathOrUrl === remote.source
      );
      expect(entry?.versions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            commit: remote.v1,
            frameworks: [expect.objectContaining({ id: 'foundry' })],
          }),
          expect.objectContaining({
            commit: remote.v2,
            frameworks: [expect.objectContaining({ id: 'foundry' })],
          }),
        ])
      );

      const v2Pin = {
        url: remote.url,
        commit: remote.v2,
        ref: 'v2.0.0',
        refKind: 'tag' as const,
      };
      const artifacts = await request<{
        data: {
          artifacts: Array<{
            contractName: string;
            artifactPath: string;
            variant?: { solcVersion?: string; profile?: string };
          }>;
        };
      }>(app, 'POST', '/api/v1/artifacts/list', {
        pathOrUrl: remote.url,
        pluginId: 'foundry',
        pin: v2Pin,
      });
      const variant = artifacts.data.artifacts.find(
        (artifact) =>
          artifact.contractName === 'VariantLibrary' &&
          artifact.variant?.profile === 'via-ir'
      );
      expect(variant, JSON.stringify(artifacts.data.artifacts)).toMatchObject({
        contractName: 'VariantLibrary',
        variant: expect.objectContaining({ profile: 'via-ir' }),
      });
      expect(artifacts.data.artifacts).toContainEqual(
        expect.objectContaining({
          contractName: 'VersionedThing',
          artifactPath: 'out/VersionedThing.sol/VersionedThing.json',
        })
      );

      const v1Pin = {
        url: remote.url,
        commit: remote.v1,
        ref: 'v1.0.0',
        refKind: 'tag' as const,
      };
      const [v1Artifact, v2Artifact] = await Promise.all([
        request<{ data: { creationCode: string } }>(
          app,
          'POST',
          '/api/v1/artifacts/data',
          {
            pathOrUrl: remote.url,
            pluginId: 'foundry',
            artifactPath: 'out/VersionedThing.sol/VersionedThing.json',
            pin: v1Pin,
          }
        ),
        request<{ data: { creationCode: string } }>(
          app,
          'POST',
          '/api/v1/artifacts/data',
          {
            pathOrUrl: remote.url,
            pluginId: 'foundry',
            artifactPath: 'out/VersionedThing.sol/VersionedThing.json',
            pin: v2Pin,
          }
        ),
      ]);
      expect(v1Artifact.data.creationCode).not.toBe(
        v2Artifact.data.creationCode
      );

      const plan: DeploymentPlan = {
        schemaVersion: 1,
        contracts: [
          {
            id: 'versioned-thing-v1',
            repoPathOrUrl: remote.url,
            frameworkId: 'foundry',
            sourcePath: 'src/VersionedThing.sol',
            contractName: 'VersionedThing',
            artifactPath: 'out/VersionedThing.sol/VersionedThing.json',
            pin: v1Pin,
          },
          {
            id: 'versioned-thing-v2',
            repoPathOrUrl: remote.url,
            frameworkId: 'foundry',
            sourcePath: 'src/VersionedThing.sol',
            contractName: 'VersionedThing',
            artifactPath: 'out/VersionedThing.sol/VersionedThing.json',
            pin: v2Pin,
          },
        ],
        steps: [
          { id: 'deploy-v1', kind: 'deploy', contractId: 'versioned-thing-v1' },
          { id: 'deploy-v2', kind: 'deploy', contractId: 'versioned-thing-v2' },
        ],
        chains: [CHAIN_ID],
        signers: {
          global: {
            pluginId: 'private-key',
            accountId: KEY_ID,
            address: SIGNER,
          },
        },
      };
      const validation = await validatePlan(
        plan,
        { [CHAIN_ID]: rpcId },
        {
          profileId: PROFILE,
          listAccounts: async () => (await signer.listAccounts(true)).providers,
          captureBundles: async () => ({}),
        }
      );
      expect(
        Object.values(validation.report.chains[String(CHAIN_ID)]).every(
          (item) => !item.blocking || item.ok
        ),
        JSON.stringify(validation.report)
      ).toBe(true);
      const launched = await request<{ data: { run: RunRecord } }>(
        app,
        'POST',
        '/api/v1/deployments/runs',
        {
          plan,
          rpcSelection: { [CHAIN_ID]: rpcId },
          name: 'two releases from one repository',
          idempotencyKey: crypto.randomUUID(),
        }
      );
      const run = await waitForRun(
        engine,
        launched.data.run.id,
        (candidate) => candidate.status === 'completed'
      );
      const [v1Address, v2Address] = run.lanes[String(CHAIN_ID)].steps.map(
        (step) => step.address as Hex
      );
      expect(v1Address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(v2Address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(v1Address).not.toBe(v2Address);
      await expect(readVersion(anvil.rpcUrl, v1Address)).resolves.toBe(1n);
      await expect(readVersion(anvil.rpcUrl, v2Address)).resolves.toBe(2n);

      const group = pins.groupDir(remote.url);
      expect((await fs.stat(path.join(group, 'repo.git'))).isDirectory()).toBe(
        true
      );
      expect(
        (await fs.stat(path.join(group, 'versions', remote.v1))).isDirectory()
      ).toBe(true);
      expect(
        (await fs.stat(path.join(group, 'versions', remote.v2))).isDirectory()
      ).toBe(true);
      expect((await fs.readdir(path.join(group, 'versions'))).sort()).toEqual(
        [remote.v1, remote.v2].sort()
      );
    }, 300_000);
  }
);

function makeApp(
  engine: InstanceType<typeof DeployEngine>,
  signer: InstanceType<typeof SignerProviderService>
): FastifyInstance {
  const repos = RepoService.getInstance();
  // addRepoVersion intentionally captures this callback before invoking it;
  // bind the real service methods so this HTTP proof takes the production
  // materialization path without changing the handler contract.
  const profiles = createProfileHandlers({
    repos: {
      removeVersionCheckout: repos.removeVersionCheckout.bind(repos),
      getVersionSource: repos.getVersionSource.bind(repos),
      resolveLocalVersionCommit: repos.resolveLocalVersionCommit.bind(repos),
      resolveCachedVersionCommit: repos.resolveCachedVersionCommit.bind(repos),
      ensureVersion: repos.ensureVersion.bind(repos),
      withVersionMaterialized: repos.withVersionMaterialized.bind(repos),
    } as never,
  });
  const compiler = createCompilerHandlers();
  const deployments = createDeploymentHandlers({
    engine,
    getProfileManager: async () => ({ getCurrentProfile: () => PROFILE }),
    validate: (plan, selection, options) =>
      validatePlan(plan, selection, {
        ...options,
        listAccounts: async () => (await signer.listAccounts(true)).providers,
        captureBundles: async () => ({}),
      }),
  });
  const app = fastify();
  app.put('/api/v1/profiles/:id/repos', profiles.saveRepo);
  app.get('/api/v1/profiles/:id/repos', profiles.listRepos);
  app.post('/api/v1/profiles/:id/repos/versions', profiles.addRepoVersion);
  app.post('/api/v1/artifacts/list', compiler.listArtifacts);
  app.post('/api/v1/artifacts/data', compiler.getArtifactData);
  app.post('/api/v1/deployments/runs', deployments.createDeploymentRun);
  return app;
}

async function request<T>(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown
): Promise<T> {
  const response =
    body === undefined
      ? await app.inject({ method, url })
      : await app.inject({
          method,
          url,
          payload: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as T;
}

async function makeFixtureRemote(root: string): Promise<FixtureRemote> {
  const source = path.join(root, 'source');
  const bare = path.join(root, 'versioned-thing.git');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(source, 'foundry.toml'),
    '[profile.default]\nsolc = "0.8.30"\n'
  );
  await writeVersionedThing(source, 1);
  await git(source, ['init']);
  await git(source, ['config', 'user.email', 'multi-version@example.test']);
  await git(source, ['config', 'user.name', 'Multi Version Fixture']);
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'VersionedThing v1']);
  await git(source, ['tag', 'v1.0.0']);
  const v1 = (await git(source, ['rev-parse', 'HEAD'])).trim();

  await writeVersionedThing(source, 2);
  await fs.writeFile(
    path.join(source, 'src', 'VariantLibrary.sol'),
    '// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\nlibrary VariantLibrary { function marker(uint256 value) external pure returns (uint256) { return value + 1; } }\n'
  );
  await fs.writeFile(
    path.join(source, 'src', 'DefaultLibraryConsumer.sol'),
    '// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\nimport {VariantLibrary} from "./VariantLibrary.sol";\ncontract DefaultLibraryConsumer { function marker() external pure returns (uint256) { return VariantLibrary.marker(1); } }\n'
  );
  await fs.writeFile(
    path.join(source, 'src', 'VariantLibraryConsumer.sol'),
    '// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\nimport {VariantLibrary} from "./VariantLibrary.sol";\ncontract VariantLibraryConsumer { function marker() external pure returns (uint256) { return VariantLibrary.marker(2); } }\n'
  );
  await fs.writeFile(
    path.join(source, 'foundry.toml'),
    '[profile.default]\nsolc = "0.8.30"\nadditional_compiler_profiles = [{ name = "via-ir", via_ir = true }]\ncompilation_restrictions = [{ paths = "src/VariantLibraryConsumer.sol", via_ir = true }]\n'
  );
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'VersionedThing v2 with variant']);
  await git(source, ['tag', 'v2.0.0']);
  const v2 = (await git(source, ['rev-parse', 'HEAD'])).trim();
  await exec('git', ['clone', '--bare', source, bare]);
  const url = pathToFileURL(bare).href;
  await git(source, ['remote', 'add', 'origin', url]);
  return { url, source, v1, v2 };
}

async function writeVersionedThing(
  source: string,
  version: number
): Promise<void> {
  await fs.writeFile(
    path.join(source, 'src', 'VersionedThing.sol'),
    `// SPDX-License-Identifier: MIT\npragma solidity 0.8.30;\ncontract VersionedThing { function version() external pure returns (uint256) { return ${version}; } }\n`
  );
}

async function configureSigner(): Promise<
  InstanceType<typeof SignerProviderService>
> {
  const vault = new VaultStore({
    getMasterKey: async () => Buffer.alloc(32, 21),
  });
  await new PluginConfigStore().setValue('private-key', 'keys', [
    { id: KEY_ID, values: { label: 'multi-version' } },
  ]);
  await vault.setSecret('private-key', `keys.${KEY_ID}.private-key`, KEY);
  const executor = new PluginExecutor({ vaultStore: vault });
  const invoker = new PluginInvoker({
    executeContainer: (id, operation, options, opts) =>
      executor.execute(id, operation, options, opts),
  });
  return new SignerProviderService({
    invoke: (id, operation, params, opts) =>
      invoker.invoke(id, operation, params, opts),
  });
}

async function startAnvil(): Promise<Anvil> {
  const container = await docker.createContainer({
    Image: ANVIL_IMAGE,
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
  if (!port) throw new Error('anvil port missing');
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (
        (await createPublicClient({ transport: http(rpcUrl) }).getChainId()) ===
        CHAIN_ID
      )
        return { container, rpcUrl };
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('anvil did not start');
}

async function seedRpc(rpcUrl: string): Promise<string> {
  await new ChainRegistry().upsertCustomChain({
    chainId: CHAIN_ID,
    name: 'Multi-version Anvil',
    shortName: 'multi-version-anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: [],
  });
  return (
    await new RpcStore().add(CHAIN_ID, {
      url: rpcUrl,
      label: 'Multi-version Anvil',
    })
  ).id;
}

async function waitForJob(
  jobs: InstanceType<typeof JobManager>,
  id: string
): Promise<JobRecord> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const job = jobs.get(id);
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.state))
      return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

async function waitForRun(
  engine: InstanceType<typeof DeployEngine>,
  id: string,
  predicate: (run: RunRecord) => boolean
): Promise<RunRecord> {
  const deadline = Date.now() + 180_000;
  let last: RunRecord | undefined;
  while (Date.now() < deadline) {
    last = await engine.get(PROFILE, id);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for run: ${JSON.stringify(last)}`);
}

async function readVersion(rpcUrl: string, address: Hex): Promise<bigint> {
  return createPublicClient({ transport: http(rpcUrl) }).readContract({
    address,
    abi: [
      {
        type: 'function',
        name: 'version',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ type: 'uint256' }],
      },
    ],
    functionName: 'version',
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    })
  ).stdout;
}
