import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DeploymentArtifact, PointerSuggestion, WorkflowDocument } from '@ignite/api';
import { PointerSuggestionService } from '../../deployments/PointerSuggestionService.js';

const EXACT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const A = '0x1111111111111111111111111111111111111111' as const;

describe('PointerSuggestionService', () => {
  let home: string;
  let repo: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-suggestions-'));
    repo = path.join(home, 'workflow-repo');
    await fs.mkdir(repo, { recursive: true });
  });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it('merges profile and repo artifacts, preserves provenance, prefers artifact-hash matches, dedups, and caps eight per chain', async () => {
    const profileDir = path.join(home, 'profiles', 'p1', 'deployments', 'artifacts');
    const repoDir = path.join(repo, 'ignite', 'deployments', 'release');
    await fs.mkdir(profileDir, { recursive: true }); await fs.mkdir(repoDir, { recursive: true });
    await writeArtifact(path.join(profileDir, 'name-only.json'), artifact('profile-name', A, OTHER, '2026-07-10T00:00:00.000Z'));
    await writeArtifact(path.join(repoDir, 'exact.json'), artifact('repo-exact', A, EXACT, '2026-07-11T00:00:00.000Z', 'v2.0.0'));
    for (let index = 2; index <= 12; index += 1) {
      const address = `0x${index.toString(16).padStart(40, '0')}`;
      await writeArtifact(path.join(profileDir, `run-${index}.json`), artifact(`run-${index}`, address as `0x${string}`, OTHER, `2026-07-${String(index).padStart(2, '0')}T00:00:00.000Z`));
    }
    await fs.writeFile(path.join(profileDir, 'malformed.json'), '{bad');
    const service = serviceFor({ home, repo });

    const result = await service.suggest({
      workflow: { repoPathOrUrl: repo, name: 'release' }, sourceId: 'token', expectedArtifactHash: EXACT,
      contractName: 'Token', chainIds: [1],
    }, 'p1');

    expect(result.suggestionsByChain['1']).toHaveLength(8);
    expect(result.suggestionsByChain['1'].slice(1).map((entry) => Number.parseInt(entry.address.slice(2), 16))).toEqual([12, 11, 10, 9, 8, 7, 6]);
    expect(result.suggestionsByChain['1'].find((entry: PointerSuggestion) => entry.address.toLowerCase() === A.toLowerCase())).toMatchObject({
      match: 'artifact-hash', versionLabel: 'v2.0.0',
      sources: expect.arrayContaining([
        { kind: 'artifact', runId: 'profile-name', at: '2026-07-10T00:00:00.000Z' },
        { kind: 'artifact', runId: 'repo-exact', at: '2026-07-11T00:00:00.000Z' },
      ]),
    });
    expect(result.truncated).toBe(false);
  });

  it('enforces the 512-file, depth-four, regular-file/no-symlink scan boundary and reports truncation', async () => {
    const profileDir = path.join(home, 'profiles', 'p1', 'deployments', 'artifacts');
    await fs.mkdir(profileDir, { recursive: true });
    const raw = JSON.stringify(artifact('bulk', A, OTHER, '2026-07-10T00:00:00.000Z'));
    await Promise.all(Array.from({ length: 513 }, (_, index) => fs.writeFile(path.join(profileDir, `${String(index).padStart(4, '0')}.json`), raw)));
    const outside = path.join(home, 'outside.json'); await fs.writeFile(outside, raw);
    await fs.symlink(outside, path.join(profileDir, 'newest-symlink.json'));
    const deep = path.join(profileDir, 'one', 'two', 'three', 'four', 'five'); await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'too-deep.json'), raw);
    const repoDir = path.join(repo, 'ignite', 'deployments', 'release'); await fs.mkdir(repoDir, { recursive: true });
    const newestAddress = '0xffffffffffffffffffffffffffffffffffffffff' as const;
    await writeArtifact(path.join(repoDir, 'newest.json'), artifact('newest-repo', newestAddress, OTHER, '2030-07-14T00:00:00.000Z'));
    const readFile = vi.fn((file: string, encoding: BufferEncoding) => fs.readFile(file, encoding));
    const service = serviceFor({ home, repo, readFile });

    const result = await service.suggest({ workflow: { repoPathOrUrl: repo, name: 'release' }, contractName: 'Token', chainIds: [1] }, 'p1');

    expect(readFile).toHaveBeenCalledTimes(512);
    expect(result.truncated).toBe(true);
    expect(result.suggestionsByChain['1'].some((entry) => entry.address.toLowerCase() === newestAddress)).toBe(true);
  });

  it('rejects an unknown workflow sourceId before scanning or invoking hooks', async () => {
    const hooks = { suggest: vi.fn(async () => []) };
    const service = serviceFor({ home, repo, hooks });
    await expect(service.suggest({ workflow: { repoPathOrUrl: repo, name: 'release' }, sourceId: 'missing', contractName: 'Token', chainIds: [1] }, 'p1'))
      .rejects.toMatchObject({ code: 'WORKFLOW_SOURCE_NOT_FOUND' });
    expect(hooks.suggest).not.toHaveBeenCalled();
  });

  it('stops before reading past the 64 MiB aggregate budget and marks a five-second deadline as truncated', async () => {
    const profileDir = path.join(home, 'profiles', 'p1', 'deployments', 'artifacts');
    await fs.mkdir(profileDir, { recursive: true });
    const huge = path.join(profileDir, 'huge.json');
    await fs.writeFile(huge, '{}'); await fs.truncate(huge, 64 * 1024 * 1024 + 1);
    const byteRead = vi.fn((file: string, encoding: BufferEncoding) => fs.readFile(file, encoding));
    const byteService = serviceFor({ home, repo, readFile: byteRead });
    await expect(byteService.suggest({ contractName: 'Token', chainIds: [1] }, 'p1')).resolves.toMatchObject({ truncated: true });
    expect(byteRead).not.toHaveBeenCalled();

    await fs.rm(huge);
    await fs.writeFile(path.join(profileDir, 'valid.json'), JSON.stringify(artifact('deadline', A, OTHER, '2026-07-10T00:00:00.000Z')));
    let clockCalls = 0;
    const deadlineService = new PointerSuggestionService({
      baseDir: home, resolveWorkspace: async () => repo, readWorkflow: async () => workflow(), hooks: { suggest: async () => [] },
      now: () => clockCalls++ === 0 ? 0 : 5_000,
    });
    await expect(deadlineService.suggest({ contractName: 'Token', chainIds: [1] }, 'p1')).resolves.toMatchObject({ truncated: true, suggestionsByChain: { '1': [] } });
  });

  it('fans out only to workflow-selected hooks and merges plugin suggestions at name quality', async () => {
    const hooks = { suggest: vi.fn(async (ids: string[]) => [{ pluginId: ids[0], chainId: 1, address: A, label: 'History' }]) };
    const service = serviceFor({ home, repo, hooks });
    const result = await service.suggest({ workflow: { repoPathOrUrl: repo, name: 'release' }, contractName: 'Token', chainIds: [1] }, 'p1');
    expect(hooks.suggest).toHaveBeenCalledWith(['selected-hook'], repo, { chainIds: [1], contractName: 'Token' });
    expect(result.suggestionsByChain['1'][0]).toMatchObject({ address: A, match: 'name', sources: [{ kind: 'plugin', pluginId: 'selected-hook', label: 'History' }] });
  });
});

function serviceFor(options: { home: string; repo: string; hooks?: { suggest: (...args: any[]) => Promise<any[]> }; readFile?: (file: string, encoding: BufferEncoding) => Promise<string> }) {
  return new PointerSuggestionService({
    baseDir: options.home,
    resolveWorkspace: async () => options.repo,
    readWorkflow: async () => workflow(),
    hooks: options.hooks ?? { suggest: async () => [] },
    ...(options.readFile ? { readFile: options.readFile as typeof fs.readFile } : {}),
  });
}

function workflow(): WorkflowDocument {
  return {
    schemaVersion: 1,
    sources: [{ id: 'token', repo: { url: 'https://example.test/token.git', commit: 'a'.repeat(40) }, frameworkId: 'foundry', sourcePath: 'src/Token.sol', artifactPath: 'out/Token.json', contractName: 'Token', artifactHash: EXACT }],
    steps: [{ id: 'deploy', kind: 'deploy', contractId: 'token' }],
    requiredPlugins: [{ id: 'foundry', version: '1' }, { id: 'selected-hook', version: '1' }], outputs: { hooks: ['selected-hook'] },
  };
}

async function writeArtifact(file: string, value: DeploymentArtifact): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value));
  await fs.utimes(file, new Date(value.updatedAt), new Date(value.updatedAt));
}

function artifact(runId: string, address: `0x${string}`, artifactHash: string, updatedAt: string, versionLabel?: string): DeploymentArtifact {
  const item = { ok: true, blocking: false, message: 'ok' };
  return {
    schemaVersion: 2, runId, profileId: 'p1', name: runId, status: 'completed', createdAt: updatedAt, updatedAt,
    contracts: [{ id: 'token', repoName: 'token', sourcePath: 'src/Token.sol', contractName: 'Token', artifactHash, compiler: { pluginId: 'foundry', version: '1', settingsHash: OTHER }, ...(versionLabel ? { versionLabel } : {}) }],
    validation: { chains: { '1': { rpc: item, signers: item, args: item, estimation: item, balance: item, inputs: item } } },
    lanes: { '1': { chainId: 1, status: 'completed', providerLabel: 'RPC', steps: [{ stepId: 'deploy', kind: 'deploy', contractId: 'token', status: 'confirmed', args: {}, value: '0', address, attempts: [] }] } },
  };
}
