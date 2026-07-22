// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { artifactListReceived, compilerReducer, listArtifacts } from '../compilerSlice';

describe('version-scoped compiler requests', () => {
  it('parses ready, pending, and busy artifact responses without reading undefined artifacts', () => {
    const ready = compilerReducer(undefined, artifactListReceived({
      repoPath: '/workspace/contracts', frameworkId: 'foundry', pathOrUrl: '/workspace/contracts',
      result: { status: 'ready', artifacts: [{ contractName: 'A', sourcePath: 'src/A.sol', artifactPath: 'out/A.json' }] },
    }));
    expect(ready.compilations['/workspace/contracts'].foundry).toMatchObject({
      status: 'ready', artifacts: [expect.objectContaining({ contractName: 'A' })],
    });

    const pending = compilerReducer(ready, artifactListReceived({
      repoPath: '/workspace/contracts', frameworkId: 'foundry', pathOrUrl: '/workspace/contracts',
      result: { status: 'pending', jobId: 'job-compile' },
    }));
    expect(pending.compilations['/workspace/contracts'].foundry).toMatchObject({
      status: 'waiting', waiting: 'pending', waitingJobId: 'job-compile',
    });

    const busy = compilerReducer(undefined, artifactListReceived({
      repoPath: '/workspace/new', frameworkId: 'foundry', pathOrUrl: '/workspace/new',
      result: { status: 'busy' },
    }));
    expect(busy.compilations['/workspace/new'].foundry).toMatchObject({
      status: 'waiting', waiting: 'busy',
    });
    expect(busy.compilations['/workspace/new'].foundry.artifacts).toBeUndefined();
  });

  it('carries the version pin when listing artifacts', () => {
    const pin = { url: 'https://example.test/contracts.git', commit: 'a'.repeat(40), ref: 'v1.2.3' };
    const action = listArtifacts({ pathOrUrl: '/workspace/contracts', pluginId: 'foundry', pin });
    expect(action.payload).toMatchObject({
      endpoint: 'listArtifacts',
      body: { pathOrUrl: '/workspace/contracts', pluginId: 'foundry', pin },
    });
  });
});
