import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BundleStore,
  type VerificationBundle,
} from '../../verifications/BundleStore.js';

const HASH = 'a'.repeat(64);

function bundle(): VerificationBundle {
  return {
    schemaVersion: 1,
    standardJsonInput: {
      language: 'Solidity',
      sources: {
        'src/Token.sol': { content: 'contract Token {}' },
      },
      settings: { optimizer: { enabled: true, runs: 200 } },
    },
    solcVersion: 'v0.8.26+commit.8a97fa7a',
    contractIdentifier: 'src/Token.sol:Token',
    creationCode: '0x6000',
    artifactHash: HASH,
    compilerSummary: {
      pluginId: 'foundry',
      optimizer: true,
      runs: 200,
      viaIR: false,
    },
  };
}

describe('BundleStore', () => {
  let home: string;
  let store: BundleStore;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-bundles-'));
    store = new BundleStore({ baseDir: home });
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('accepts a Solidity standard-json bundle', () => {
    expect(() => BundleStore.validate(bundle())).not.toThrow();
  });

  it.each([
    ['non-object input', null],
    ['wrong language', { ...bundle(), standardJsonInput: { language: 'Yul', sources: {}, settings: {} } }],
    ['source urls', { ...bundle(), standardJsonInput: { language: 'Solidity', sources: { 'src/T.sol': { urls: ['ipfs://x'] } }, settings: {} } }],
    ['missing source content', { ...bundle(), standardJsonInput: { language: 'Solidity', sources: { 'src/T.sol': {} }, settings: {} } }],
    ['traversal source', { ...bundle(), standardJsonInput: { language: 'Solidity', sources: { '../T.sol': { content: 'x' } }, settings: {} } }],
    ['absolute source', { ...bundle(), standardJsonInput: { language: 'Solidity', sources: { '/T.sol': { content: 'x' } }, settings: {} } }],
    ['missing settings', { ...bundle(), standardJsonInput: { language: 'Solidity', sources: {} } }],
  ])('rejects %s', (_name, data) => {
    expect(() => BundleStore.validate(data as never)).toThrow();
    try {
      BundleStore.validate(data as never);
    } catch (error) {
      expect(error).toMatchObject({ code: 'BUNDLE_INVALID' });
    }
  });

  it('rejects standard-json input larger than 10 MiB', () => {
    const tooLarge = {
      ...bundle(),
      standardJsonInput: {
        language: 'Solidity',
        sources: { 'src/Large.sol': { content: 'x'.repeat(10 * 1024 * 1024) } },
        settings: {},
      },
    };

    expect(() => BundleStore.validate(tooLarge)).toThrow();
    try {
      BundleStore.validate(tooLarge);
    } catch (error) {
      expect(error).toMatchObject({ code: 'BUNDLE_TOO_LARGE' });
    }
  });

  it('hashes canonical JSON independently of object key order', () => {
    const first = bundle();
    const second: VerificationBundle = {
      ...bundle(),
      standardJsonInput: {
        settings: { optimizer: { runs: 200, enabled: true } },
        sources: { 'src/Token.sol': { content: 'contract Token {}' } },
        language: 'Solidity',
      },
    };

    expect(BundleStore.hash(first)).toBe(BundleStore.hash(second));
  });

  it('round-trips bundles and does not rewrite an existing content hash', async () => {
    const value = bundle();
    const hash = await store.write('profile-1', value);
    const file = path.join(
      home,
      'profiles',
      'profile-1',
      'deployments',
      'bundles',
      `${hash}.json`,
    );
    const firstMtime = (await fs.stat(file)).mtimeMs;

    expect(await store.read('profile-1', hash)).toEqual(value);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await store.write('profile-1', value)).toBe(hash);
    expect((await fs.stat(file)).mtimeMs).toBe(firstMtime);
    expect(await store.read('other-profile', hash)).toBeNull();
  });
});
