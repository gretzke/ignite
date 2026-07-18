import assert from 'node:assert/strict';
import test from 'node:test';

// Avoid invoking the CLI entrypoint while importing the built helper.
process.env.IGNITE_PLUGIN_BUILD = 'true';
const { parseFoundryArtifactVariant } = await import('./dist/index.js');

const source = 'src/IShared.sol';
const contract = 'IShared';

test('parses Foundry compiler-profile variants from artifact filenames only', () => {
  assert.equal(
    parseFoundryArtifactVariant('out/src/IShared.sol/IShared.json', source, contract),
    undefined,
  );
  assert.deepEqual(
    parseFoundryArtifactVariant('out/src/IShared.sol/IShared.0.8.30.json', source, contract),
    { solcVersion: '0.8.30' },
  );
  assert.deepEqual(
    parseFoundryArtifactVariant('out/src/IShared.sol/IShared.0.8.30.optimized.json', source, contract),
    { solcVersion: '0.8.30', profile: 'optimized' },
  );
  assert.deepEqual(
    parseFoundryArtifactVariant('out/src/IShared.sol/IShared.default.json', source, contract),
    { profile: 'default' },
  );
});

test('does not derive a variant when the source directory or contract name differs', () => {
  assert.equal(
    parseFoundryArtifactVariant('out/src/Other.sol/IShared.default.json', source, contract),
    undefined,
  );
  assert.equal(
    parseFoundryArtifactVariant('out/src/IShared.sol/Other.default.json', source, contract),
    undefined,
  );
});
