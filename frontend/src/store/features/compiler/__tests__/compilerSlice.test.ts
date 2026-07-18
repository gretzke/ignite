// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { listArtifacts } from '../compilerSlice';

describe('version-scoped compiler requests', () => {
  it('carries the version pin when listing artifacts', () => {
    const pin = { url: 'https://example.test/contracts.git', commit: 'a'.repeat(40), ref: 'v1.2.3' };
    const action = listArtifacts({ pathOrUrl: '/workspace/contracts', pluginId: 'foundry', pin });
    expect(action.payload).toMatchObject({
      endpoint: 'listArtifacts',
      body: { pathOrUrl: '/workspace/contracts', pluginId: 'foundry', pin },
    });
  });
});
