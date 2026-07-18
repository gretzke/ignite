// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ArtifactLocation } from '@ignite/api';
import { buildPathTree, directArtifactForFile, getDirectoryContents } from '../pathTree';

const artifact = (
  contractName: string,
  sourcePath: string,
  artifactPath: string
): ArtifactLocation => ({ contractName, sourcePath, artifactPath });

describe('buildPathTree', () => {
  it('sets variantCount to one for a single-artifact contract', () => {
    const tree = buildPathTree([
      artifact('Token', 'src/Token.sol', 'out/Token.sol/Token.json'),
    ]);

    const { files } = getDirectoryContents(tree, 'src');

    expect(files).toHaveLength(1);
    expect(files[0].variantCount).toBe(1);
  });

  it('keeps one canonical row and counts distinct artifact variants', () => {
    const canonical = artifact('Foo', 'src/Foo.sol', 'out/Foo.json');
    const tree = buildPathTree([
      artifact('Foo', 'src/Foo.sol', 'out/Foo.0.8.17.json'),
      artifact('Foo', 'src/Foo.sol', 'out-optimized/Foo.json'),
      canonical,
    ]);

    const { files } = getDirectoryContents(tree, 'src');

    expect(files).toHaveLength(1);
    expect(files[0].variantCount).toBe(3);
    expect(files[0].artifact).toBe(canonical);
  });

  it('refuses to expose the canonical artifact as a direct pick for a multi-variant row', () => {
    const tree = buildPathTree([
      artifact('Foo', 'src/Foo.sol', 'out/Foo.json'),
      artifact('Foo', 'src/Foo.sol', 'out/Foo.0.8.17.optimized.json'),
    ]);

    const { files } = getDirectoryContents(tree, 'src');

    expect(files[0].variantCount).toBe(2);
    expect(directArtifactForFile(files[0])).toBeUndefined();
  });

  it('counts exact duplicate artifact paths once', () => {
    const duplicate = artifact('Foo', 'src/Foo.sol', 'out/Foo.json');
    const tree = buildPathTree([
      duplicate,
      { ...duplicate },
      artifact('Foo', 'src/Foo.sol', 'out/Foo.0.8.17.json'),
    ]);

    const { files } = getDirectoryContents(tree, 'src');

    expect(files).toHaveLength(1);
    expect(files[0].variantCount).toBe(2);
  });

  it('keeps separate rows for different contracts in one source file', () => {
    const tree = buildPathTree([
      artifact('Alpha', 'src/Contracts.sol', 'out/Contracts.sol/Alpha.json'),
      artifact('Beta', 'src/Contracts.sol', 'out/Contracts.sol/Beta.json'),
    ]);

    const { files } = getDirectoryContents(tree, 'src');

    expect(files).toHaveLength(2);
    expect(files.map((file) => file.artifact.contractName)).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(files.map((file) => file.variantCount)).toEqual([1, 1]);
  });
});
