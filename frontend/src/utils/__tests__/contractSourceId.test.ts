// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { contractSourceId } from '../contractSourceId';

const base = {
  repoPathOrUrl: '/repo',
  frameworkId: 'foundry',
  artifactPath: 'out/Token.sol/Token.json',
  contractName: 'Token',
  sourcePath: 'src/Token.sol',
};

describe('contractSourceId', () => {
  it('differs for identical artifacts in different repos', () => {
    expect(contractSourceId(base)).not.toEqual(
      contractSourceId({ ...base, repoPathOrUrl: '/other' })
    );
  });

  it('is deterministic for equal inputs', () => {
    expect(contractSourceId({ ...base })).toEqual(contractSourceId({ ...base }));
  });

  it('distinguishes identical contracts from two pinned commits', () => {
    const first = contractSourceId({
      ...base,
      pin: { url: 'https://example.test/contracts.git', commit: 'a'.repeat(40) },
    });
    const second = contractSourceId({
      ...base,
      pin: { url: 'https://example.test/contracts.git', commit: 'b'.repeat(40) },
    });

    expect(first).not.toEqual(second);
    expect(first).toContain('aaaaaaaaaaaa');
    expect(second).toContain('bbbbbbbbbbbb');
  });

  it('keeps unpinned source ids in the legacy format', () => {
    const legacy = [
      base.repoPathOrUrl,
      base.frameworkId,
      base.artifactPath,
      base.contractName,
    ]
      .map(encodeURIComponent)
      .join(':');

    expect(contractSourceId(base)).toEqual(legacy);
  });

  it('does not collide where naive delimiter-joining would', () => {
    // Naive `${repo}:${framework}` joining maps both tuples to 'a:b:c:...'.
    const a = contractSourceId({ ...base, repoPathOrUrl: 'a:b', frameworkId: 'c' });
    const b = contractSourceId({ ...base, repoPathOrUrl: 'a', frameworkId: 'b:c' });
    expect(a).not.toEqual(b);
  });
});
