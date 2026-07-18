import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ContractSource } from '@ignite/api';
import { PluginType } from '@ignite/plugin-types/types';
import {
  getCompilerArtifactData,
  getCompilerVerificationBundle,
} from '../../api/plugins/compiler/index.js';

const commit = 'a'.repeat(40);
const contract: ContractSource = {
  id: 'pinned-contract',
  repoPathOrUrl: 'https://example.test/contracts.git',
  frameworkId: 'foundry',
  artifactPath: 'out/C.sol/C.json',
  contractName: 'C',
  sourcePath: 'src/C.sol',
  pin: {
    url: 'https://example.test/contracts.git',
    commit,
    ref: 'v1',
  },
};

function pinnedReadDeps(checkout: string, operation: 'getArtifactData' | 'getVerificationBundle') {
  let lockHeld = false;
  let deleteRequested = false;
  let deleted = false;
  const deleteCheckout = async () => {
    deleteRequested = true;
    if (!lockHeld) {
      deleted = true;
      await fs.rm(checkout, { recursive: true, force: true });
    }
  };
  const repos = {
    resolveExistingWorkspacePath: vi.fn(),
    ensureVersion: vi.fn(),
    withVersionMaterialized: vi.fn(async (_profileId, _url, _commit, _opts, fn) => {
      lockHeld = true;
      try {
        return await fn({ checkout, rematerialize: async () => ({ checkout }) });
      } finally {
        lockHeld = false;
        if (deleteRequested) {
          deleted = true;
          await fs.rm(checkout, { recursive: true, force: true });
        }
      }
    }),
  };
  const executor = {
    execute: vi.fn(async (_pluginId: string, actualOperation: string, _input: unknown, options: { workspacePath: string }) => {
      expect(actualOperation).toBe(operation);
      await deleteCheckout();
      expect(lockHeld).toBe(true);
      expect(deleted).toBe(false);
      const marker = await fs.readFile(path.join(options.workspacePath, 'marker.txt'), 'utf8');
      return actualOperation === 'getArtifactData'
        ? { success: true, data: { marker } }
        : { success: true, data: { marker } };
    }),
  };
  return {
    deps: {
      executor: executor as never,
      registryLoader: {
        getPluginConfig: vi.fn(async () => ({ metadata: { types: [PluginType.COMPILER] } })),
      } as never,
      repos: repos as never,
    },
    executor,
    wasDeleted: () => deleted,
  };
}

describe('continuous pinned compiler reads', () => {
  it('keeps getArtifactData inside the materialization lock until plugin execution finishes', async () => {
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-artifact-lock-'));
    await fs.writeFile(path.join(checkout, 'marker.txt'), 'pinned artifact');
    const harness = pinnedReadDeps(checkout, 'getArtifactData');

    const result = await getCompilerArtifactData(harness.deps, { contract, profileId: 'p1' });

    expect(result).toMatchObject({ marker: 'pinned artifact' });
    expect(harness.wasDeleted()).toBe(true);
    expect(harness.executor.execute).toHaveBeenCalledWith(
      'foundry',
      'getArtifactData',
      expect.any(Object),
      { workspacePath: checkout }
    );
  });

  it('keeps getVerificationBundle inside the materialization lock until plugin execution finishes', async () => {
    const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-bundle-lock-'));
    await fs.writeFile(path.join(checkout, 'marker.txt'), 'pinned bundle');
    const harness = pinnedReadDeps(checkout, 'getVerificationBundle');

    const result = await getCompilerVerificationBundle(harness.deps, { contract, profileId: 'p1' });

    expect(result).toMatchObject({ marker: 'pinned bundle' });
    expect(harness.wasDeleted()).toBe(true);
    expect(harness.executor.execute).toHaveBeenCalledWith(
      'foundry',
      'getVerificationBundle',
      expect.any(Object),
      { workspacePath: checkout }
    );
  });
});
