// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { artifactVariantsForFile, canDeploySelectedArtifact } from '../FilePage';

describe('FilePage variant deploy gate', () => {
  it('refuses direct deploy for a multi-variant contract until an artifact path is explicitly selected', () => {
    const canonical = { artifactPath: 'out/Foo.sol/Foo.json' };

    expect(canDeploySelectedArtifact(canonical, null, 2)).toBe(false);
    expect(canDeploySelectedArtifact(canonical, canonical.artifactPath, 2)).toBe(true);
    expect(canDeploySelectedArtifact(canonical, null, 1)).toBe(true);
  });

  it('keeps a multi-variant file unselected until its artifact path is picked', () => {
    const selected = undefined;
    expect(canDeploySelectedArtifact(selected, null, 2)).toBe(false);
  });

  it('derives file-page variants from the artifact list without a selected artifact', () => {
    const variants = artifactVariantsForFile([
      { sourcePath: 'src/Foo.sol', contractName: 'Foo', artifactPath: 'out/Foo.sol/Foo.json' },
      { sourcePath: 'src/Foo.sol', contractName: 'Foo', artifactPath: 'out/Foo.sol/Foo.0.8.24.json' },
    ], 'src/Foo.sol', 'Foo');

    expect(variants.map(({ label }) => label)).toEqual(['default', '0.8.24']);
  });
});
