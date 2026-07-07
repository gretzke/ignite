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
    expect(grant.hostWrite).toBe(false);
    expect(grant.net).toBe(false);
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
      hostWrite: true,
      net: false,
      secrets: [],
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant.trust).toBe('trusted');
    expect(grant.hostWrite).toBe(true);
    expect(grant.net).toBe(false);

    // Survives a fresh instance (round-trips through the file)
    const fresh = new TrustManager(trustFile, async () => false);
    const reloaded = await fresh.getGrant('@acme/foundry');
    expect(reloaded.hostWrite).toBe(true);
  });

  it('a trusted plugin without a permission still lacks it', async () => {
    await manager.setTrust('@acme/foundry', 'trusted', {
      hostWrite: false,
      net: true,
      secrets: [],
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant.hostWrite).toBe(false);
    expect(grant.net).toBe(true);
  });

  it('refuses to set trust for native plugins', async () => {
    await expect(
      manager.setTrust('local-repo', 'trusted', {
        hostWrite: true,
        net: true,
        secrets: [],
      })
    ).rejects.toThrow(/native/i);
  });

  it('revoking sets untrusted with all permissions denied', async () => {
    await manager.setTrust('@acme/foundry', 'trusted', {
      hostWrite: true,
      net: true,
      secrets: [],
    });
    await manager.setTrust('@acme/foundry', 'untrusted', {
      hostWrite: true, // must be ignored for untrusted
      net: true,
      secrets: ['api-key'], // must be ignored for untrusted
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant).toEqual(UNTRUSTED_GRANT);
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
            permissions: { hostWrite: true, net: false },
            ts: 'now',
          },
        }),
        'utf8'
      );
      const grant = await manager.getGrant('@acme/foundry');
      expect(grant.trust).toBe('trusted');
      expect(grant.hostWrite).toBe(true);
      expect(grant.secrets).toEqual([]);
    });

    it('persists and round-trips granted secret keys for a trusted plugin', async () => {
      await manager.setTrust('@acme/foundry', 'trusted', {
        hostWrite: false,
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
        hostWrite: false,
        net: false,
        secrets: ['api-key'],
      });
      await manager.setTrust('@acme/foundry', 'untrusted', {
        hostWrite: false,
        net: false,
        secrets: ['api-key'], // must be ignored for untrusted
      });
      const grant = await manager.getGrant('@acme/foundry');
      expect(grant.secrets).toEqual([]);
    });
  });
});
