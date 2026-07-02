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

  it('persists and returns granted permissions', async () => {
    await manager.setTrust('@acme/foundry', 'trusted', {
      hostWrite: true,
      net: false,
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
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant.hostWrite).toBe(false);
    expect(grant.net).toBe(true);
  });

  it('refuses to set trust for native plugins', async () => {
    await expect(
      manager.setTrust('local-repo', 'trusted', { hostWrite: true, net: true })
    ).rejects.toThrow(/native/i);
  });

  it('revoking sets untrusted with all permissions denied', async () => {
    await manager.setTrust('@acme/foundry', 'trusted', {
      hostWrite: true,
      net: true,
    });
    await manager.setTrust('@acme/foundry', 'untrusted', {
      hostWrite: true, // must be ignored for untrusted
      net: true,
    });
    const grant = await manager.getGrant('@acme/foundry');
    expect(grant).toEqual(UNTRUSTED_GRANT);
  });
});
