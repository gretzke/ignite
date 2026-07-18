// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { artifactVariantLabel, groupArtifactVariants, requiresExplicitVariantPick } from '../artifactVariants';

describe('artifact variants', () => {
  it('groups variants under one contract and requires an explicit choice', () => {
    const groups = groupArtifactVariants([
      { sourcePath: 'src/Token.sol', contractName: 'Token', artifactPath: 'out/Token.sol/Token.json' },
      { sourcePath: 'src/Token.sol', contractName: 'Token', artifactPath: 'out/Token.sol/Token.0.8.30.optimized.json', variant: { solcVersion: '0.8.30', profile: 'optimized' } },
    ]);
    expect(groups).toHaveLength(1);
    expect(requiresExplicitVariantPick(groups[0])).toBe(true);
    expect(groups[0].artifacts.map(artifactVariantLabel)).toEqual(['default', 'optimized · 0.8.30']);
  });

  it('keeps single-artifact contracts on the existing no-picker path', () => {
    const [group] = groupArtifactVariants([
      { sourcePath: 'src/Token.sol', contractName: 'Token', artifactPath: 'out/Token.sol/Token.json' },
    ]);
    expect(requiresExplicitVariantPick(group)).toBe(false);
  });
});
