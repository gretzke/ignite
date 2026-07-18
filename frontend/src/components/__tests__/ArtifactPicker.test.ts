// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { ContractSourcePinSchema, type RepoVersionSummary } from '@ignite/api';
import { pinForRepoVersion } from '../ArtifactPicker';

describe('ArtifactPicker version pins', () => {
  it('carries a tag refKind into a schema-valid source pin', () => {
    const version: RepoVersionSummary = {
      url: 'https://example.test/contracts.git',
      commit: 'a'.repeat(40),
      refLabel: 'v1.2.3',
      refKind: 'tag',
      lastUsedAt: '2026-07-18T00:00:00.000Z',
    };

    expect(ContractSourcePinSchema.parse(pinForRepoVersion(version))).toEqual({
      url: version.url,
      commit: version.commit,
      ref: version.refLabel,
      refKind: 'tag',
    });
  });
});
