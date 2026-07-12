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

  it('does not collide where naive delimiter-joining would', () => {
    // Naive `${repo}:${framework}` joining maps both tuples to 'a:b:c:...'.
    const a = contractSourceId({ ...base, repoPathOrUrl: 'a:b', frameworkId: 'c' });
    const b = contractSourceId({ ...base, repoPathOrUrl: 'a', frameworkId: 'b:c' });
    expect(a).not.toEqual(b);
  });
});
