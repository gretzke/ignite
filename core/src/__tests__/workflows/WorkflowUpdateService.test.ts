import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDocument } from '@ignite/api';
import { WorkflowUpdateService, requiredPluginRows } from '../../workflows/WorkflowUpdateService.js';
import { PluginType } from '@ignite/plugin-types/types';

const A = 'a'.repeat(40); const B = 'b'.repeat(40);

describe('WorkflowUpdateService', () => {
  it('separates semver upgrades from tag retarget/delete, detects branches, keeps commits silent, and reuses plugin version rows', async () => {
    const inspectRemote = vi.fn(async (url: string) => {
      if (url.includes('upgrade')) return remote({ releases: [{ tag: 'v2.0.0', version: '2.0.0', sha: B }, { tag: 'v1.0.0', version: '1.0.0', sha: A }] });
      if (url.includes('retarget')) return remote({ releases: [{ tag: 'v1.0.0', version: '1.0.0', sha: B }] });
      if (url.includes('deleted')) return remote({ releases: [] });
      if (url.includes('named')) return remote({ tagHeads: { stable: B } });
      return remote({ branchHeads: { main: B } });
    });
    const pluginRows = vi.fn(async () => [{ id: 'foundry', requiredVersion: '1', status: 'installed' as const, installedVersion: '1', updateAvailable: false }]);
    const service = new WorkflowUpdateService({ readWorkflow: async () => document(), inspectRemote, pluginRows });
    const result = await service.check({ repoPathOrUrl: '/repo', name: 'release' });
    expect(result.sources).toEqual([
      expect.objectContaining({ sourceId: 'upgrade', status: 'upgrade-available', upgrades: [{ ref: 'v2.0.0', commit: B, version: '2.0.0' }] }),
      expect.objectContaining({ sourceId: 'retarget', status: 'tag-retargeted', latestCommit: B }),
      expect.objectContaining({ sourceId: 'deleted', status: 'tag-deleted' }),
      expect.objectContaining({ sourceId: 'named', status: 'tag-retargeted', latestCommit: B }),
      expect.objectContaining({ sourceId: 'branch', status: 'branch-moved', latestCommit: B }),
      expect.objectContaining({ sourceId: 'commit', status: 'up-to-date' }),
    ]);
    expect(inspectRemote).toHaveBeenCalledTimes(5);
    expect(pluginRows).toHaveBeenCalledWith(document().requiredPlugins);
    expect(result.plugins).toEqual(await pluginRows());
  });

  it('reports installed, version-mismatch, and missing required plugins using the shared versions result', async () => {
    const config = (id: string, version: string) => ({ origin: 'installed' as const, repoRead: false, metadata: { id, name: id, version, baseImage: id, types: [PluginType.COMPILER], operations: [] } });
    const rows = await requiredPluginRows(
      [{ id: 'ok', version: '1' }, { id: 'old', version: '2' }, { id: 'missing', version: '1' }],
      {
        getConfig: async (id) => id === 'missing' ? undefined : config(id, '1'),
        getSource: async () => ({ kind: 'git', url: 'https://example.test/plugin', track: { mode: 'branch', branch: 'main' }, commit: A }),
        versionInfo: async (id) => ({ pluginId: id, source: 'git', updateAvailable: id === 'old' }),
      },
    );
    expect(rows).toEqual([
      expect.objectContaining({ id: 'ok', status: 'installed', installedVersion: '1', updateAvailable: false }),
      expect.objectContaining({ id: 'old', status: 'version-mismatch', installedVersion: '1', updateAvailable: true }),
      { id: 'missing', requiredVersion: '1', status: 'missing', updateAvailable: false },
    ]);
  });
});

function remote(overrides: Record<string, unknown>) { return { defaultBranch: 'main', branches: ['main'], branchHeads: { main: A }, releases: [], ...overrides } as never; }
function document(): WorkflowDocument {
  const source = (id: string, url: string, commit: string, ref?: string, refKind?: 'tag' | 'branch') => ({ id, repo: { url, commit, ...(ref ? { ref, refKind } : {}) }, frameworkId: 'foundry', sourcePath: 'src/C.sol', artifactPath: 'out/C.json', contractName: 'C' });
  return { schemaVersion: 1, sources: [
    source('upgrade', 'https://upgrade.test/repo', A, 'v1.0.0', 'tag'),
    source('retarget', 'https://retarget.test/repo', A, 'v1.0.0', 'tag'),
    source('deleted', 'https://deleted.test/repo', A, 'v1.0.0', 'tag'),
    source('named', 'https://named.test/repo', A, 'stable', 'tag'),
    source('branch', 'https://branch.test/repo', A, 'main', 'branch'),
    source('commit', 'https://commit.test/repo', A),
  ], steps: [], requiredPlugins: [{ id: 'foundry', version: '1' }], outputs: { hooks: [] } };
}
