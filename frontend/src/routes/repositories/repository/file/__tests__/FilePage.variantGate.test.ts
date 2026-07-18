// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { canDeploySelectedArtifact } from '../FilePage';

describe('FilePage variant deploy gate', () => {
  it('refuses direct deploy for a multi-variant contract until an artifact path is explicitly selected', () => {
    const canonical = { artifactPath: 'out/Foo.sol/Foo.json' };

    expect(canDeploySelectedArtifact(canonical, null, 2)).toBe(false);
    expect(canDeploySelectedArtifact(canonical, canonical.artifactPath, 2)).toBe(true);
    expect(canDeploySelectedArtifact(canonical, null, 1)).toBe(true);
  });
});
