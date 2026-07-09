import { describe, it, expect } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import { normalizeLegacyType } from '../plugins/utils/permissionCompat.js';

describe('normalizeLegacyType', () => {
  it('passes through a modern multi-type manifest unchanged', () => {
    const metadata = {
      id: 'chainz',
      types: [PluginType.RPC_PROVIDER, PluginType.SIGNER_PROVIDER],
      name: 'Chainz',
      version: '1.0.0',
      baseImage: 'x',
    };
    expect(normalizeLegacyType(metadata as never).types).toEqual([
      PluginType.RPC_PROVIDER,
      PluginType.SIGNER_PROVIDER,
    ]);
  });

  it('normalizes a legacy single-type manifest to types[]', () => {
    const legacy = {
      id: 'waffle',
      type: PluginType.COMPILER,
      name: 'Waffle',
      version: '1.0.0',
      baseImage: 'x',
    };
    const normalized = normalizeLegacyType(legacy as never);
    expect(normalized.types).toEqual([PluginType.COMPILER]);
    expect('type' in normalized).toBe(false);
  });

  it('exposes signer-provider as a plugin type', () => {
    expect(PluginType.SIGNER_PROVIDER).toBe('signer-provider');
  });
});
