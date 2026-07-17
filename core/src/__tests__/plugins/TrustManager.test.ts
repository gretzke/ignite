import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TrustManager,
  NATIVE_GRANT,
  UNTRUSTED_GRANT,
} from '../../plugins/trust/TrustManager.js';

describe('TrustManager', () => {
  let trustFile: string;
  let manager: TrustManager;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignite-trust-'));
    trustFile = path.join(dir, 'trust.json');
    manager = new TrustManager(trustFile, async (id) => id === 'local-repo');
  });

  it('grants native to registry (built-in) plugins', async () => {
    const grant = await manager.getGrant('local-repo');
    expect(grant).toEqual(NATIVE_GRANT);
  });

  it('fails closed for unknown plugins', async () => {
    const grant = await manager.getGrant('@evil/plugin');
    expect(grant).toEqual(UNTRUSTED_GRANT);
    expect(grant.repoWrite).toBe(false);
    expect(grant.net).toBe(false);
    expect(grant.contractBytecode).toBe(false);
  });

  it('fails closed when trust.json is corrupt', async () => {
    await fs.writeFile(trustFile, '{not json', 'utf8');
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant).toEqual(UNTRUSTED_GRANT);
  });

  it('fails closed when a trusted entry has a malformed permissions field', async () => {
    await fs.writeFile(
      trustFile,
      JSON.stringify({ '@acme/foundry': { trust: 'trusted', ts: 'now' } }),
      'utf8'
    );
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant).toEqual(UNTRUSTED_GRANT);
  });

  it('persists and returns granted permissions', async () => {
    await manager.setTrust('@acme/foundry', 'trusted', {
      repoWrite: true,
      net: false,
      secrets: [],
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant.trust).toBe('trusted');
    expect(grant.repoWrite).toBe(true);
    expect(grant.net).toBe(false);

    // Survives a fresh instance (round-trips through the file)
    const fresh = new TrustManager(trustFile, async () => false);
    const reloaded = await fresh.getGrant('@acme/foundry');
    expect(reloaded.repoWrite).toBe(true);
  });

  it('round-trips the contract bytecode grant and defaults missing legacy entries to false', async () => {
    await manager.setTrust('@acme/proxy', 'trusted', {
      repoWrite: false,
      net: false,
      contractBytecode: true,
      secrets: [],
    });
    expect((await manager.getGrant('@acme/proxy')).contractBytecode).toBe(true);
    await fs.writeFile(trustFile, JSON.stringify({ '@acme/old': { trust: 'trusted', permissions: { repoWrite: false, net: false, secrets: [] }, ts: 'now' } }), 'utf8');
    expect((await manager.getGrant('@acme/old')).contractBytecode).toBe(false);
  });

  it('a trusted plugin without a permission still lacks it', async () => {
    await manager.setTrust('@acme/foundry', 'trusted', {
      repoWrite: false,
      net: true,
      secrets: [],
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant.repoWrite).toBe(false);
    expect(grant.net).toBe(true);
  });

  it('refuses to set trust for native plugins', async () => {
    await expect(
      manager.setTrust('local-repo', 'trusted', {
        repoWrite: true,
        net: true,
        secrets: [],
      })
    ).rejects.toThrow(/native/i);
  });

  it('revoking sets untrusted with all permissions denied', async () => {
    await manager.setTrust('@acme/foundry', 'trusted', {
      repoWrite: true,
      net: true,
      secrets: [],
    });
    await manager.setTrust('@acme/foundry', 'untrusted', {
      repoWrite: true, // must be ignored for untrusted
      net: true,
      secrets: ['api-key'], // must be ignored for untrusted
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant).toEqual(UNTRUSTED_GRANT);
  });

  describe('legacy hostWrite migration', () => {
    it('treats a persisted hostWrite grant as repoWrite without user action', async () => {
      await fs.writeFile(
        trustFile,
        JSON.stringify({
          waffle: {
            trust: 'trusted',
            permissions: { hostWrite: true, net: false },
            ts: 'now',
          },
        }),
        'utf8'
      );
      const grant = await manager.getGrant('waffle');
      expect(grant.trust).toBe('trusted');
      expect(grant.repoWrite).toBe(true);
      expect(grant.net).toBe(false);
      expect(grant.secrets).toEqual([]);
    });

    it('fails closed on a non-true legacy hostWrite value', async () => {
      await fs.writeFile(
        trustFile,
        JSON.stringify({
          waffle: {
            trust: 'trusted',
            permissions: { hostWrite: 'yes', net: true },
            ts: 'now',
          },
        }),
        'utf8'
      );
      const grant = await manager.getGrant('waffle');
      expect(grant.repoWrite).toBe(false);
      expect(grant.net).toBe(true);
    });

    it('getAllTrust coerces legacy entries to the repoWrite shape', async () => {
      await fs.writeFile(
        trustFile,
        JSON.stringify({
          waffle: {
            trust: 'trusted',
            permissions: { hostWrite: true, net: true, secrets: [] },
            ts: 'now',
          },
        }),
        'utf8'
      );
      const all = await manager.getAllTrust();
      expect(all.waffle.permissions.repoWrite).toBe(true);
      expect(
        (all.waffle.permissions as { hostWrite?: unknown }).hostWrite
      ).toBeUndefined();
    });

    it('setTrust persists only the new repoWrite key', async () => {
      await manager.setTrust('waffle', 'trusted', {
        repoWrite: true,
        net: false,
        secrets: [],
      });
      const raw = JSON.parse(await fs.readFile(trustFile, 'utf8'));
      expect(raw.waffle.permissions).toEqual({
        repoWrite: true,
        net: false,
        contractBytecode: false,
        secrets: [],
      });
      expect('hostWrite' in raw.waffle.permissions).toBe(false);
    });
  });

  describe('secrets dimension', () => {
    it('NATIVE_GRANT and UNTRUSTED_GRANT carry empty secrets', () => {
      expect(NATIVE_GRANT.secrets).toEqual([]);
      expect(UNTRUSTED_GRANT.secrets).toEqual([]);
    });

    it('migrates a pre-existing trust.json entry with no secrets field to an empty grant', async () => {
      await fs.writeFile(
        trustFile,
        JSON.stringify({
          '@acme/foundry': {
            trust: 'trusted',
            permissions: { repoWrite: true, net: false },
            ts: 'now',
          },
        }),
        'utf8'
      );
      const grant = await manager.getGrant('@acme/foundry');
      expect(grant.trust).toBe('trusted');
      expect(grant.repoWrite).toBe(true);
      expect(grant.secrets).toEqual([]);
    });

    it('persists and round-trips granted secret keys for a trusted plugin', async () => {
      await manager.setTrust('@acme/foundry', 'trusted', {
        repoWrite: false,
        net: false,
        secrets: ['api-key'],
      });
      const grant = await manager.getGrant('@acme/foundry');
      expect(grant.secrets).toEqual(['api-key']);

      // Survives a fresh instance (round-trips through the file).
      const fresh = new TrustManager(trustFile, async () => false);
      const reloaded = await fresh.getGrant('@acme/foundry');
      expect(reloaded.secrets).toEqual(['api-key']);
    });

    it('forces secrets to empty when setting untrusted', async () => {
      await manager.setTrust('@acme/foundry', 'trusted', {
        repoWrite: false,
        net: false,
        secrets: ['api-key'],
      });
      await manager.setTrust('@acme/foundry', 'untrusted', {
        repoWrite: false,
        net: false,
        secrets: ['api-key'], // must be ignored for untrusted
      });
      const grant = await manager.getGrant('@acme/foundry');
      expect(grant.secrets).toEqual([]);
    });
  });
});
