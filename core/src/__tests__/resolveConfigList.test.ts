import { describe, it, expect, vi } from 'vitest';
import { resolveConfig } from '../plugins/config/resolveConfig.js';
import { PluginType, type PluginMetadata } from '@ignite/plugin-types/types';
import type { PermissionGrant } from '../plugins/trust/TrustManager.js';

const metadata: PluginMetadata = {
  id: 'private-key',
  types: [PluginType.SIGNER_PROVIDER],
  name: 'Private Key',
  version: '1.0.0',
  baseImage: 'x',
  configFields: [
    {
      key: 'keys',
      label: 'Private Keys',
      type: 'list',
      itemFields: [
        { key: 'label', label: 'Label', type: 'string', required: true },
        { key: 'privateKey', label: 'Private Key', type: 'string', secret: true, required: true },
      ],
    },
  ],
};

const NATIVE: PermissionGrant = { trust: 'native', repoWrite: true, net: true, secrets: [] };
const UNTRUSTED: PermissionGrant = { trust: 'untrusted', repoWrite: false, net: false, secrets: [] };

const storedItems = [
  { id: 'ab12cd34', values: { label: 'deployer' } },
  { id: 'ef56gh78', values: { label: 'ops' } },
];

function makeArgs(grant: PermissionGrant) {
  const getSecret = vi.fn(async (key: string) =>
    key === 'keys.ab12cd34.privateKey' ? '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
      : key === 'keys.ef56gh78.privateKey' ? '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
      : undefined
  );
  return {
    metadata,
    grant,
    configValues: { keys: { global: storedItems as never } },
    getSecret,
  };
}

describe('resolveConfig list fields', () => {
  it('injects items with secrets flattened in when granted (native)', async () => {
    const args = makeArgs(NATIVE);
    const result = await resolveConfig(args);
    expect(result.keys).toEqual([
      {
        id: 'ab12cd34',
        label: 'deployer',
        privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      },
      {
        id: 'ef56gh78',
        label: 'ops',
        privateKey: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
      },
    ]);
  });

  it('never reads the vault for an ungranted list field', async () => {
    const args = makeArgs(UNTRUSTED);
    const result = await resolveConfig(args);
    expect(result.keys).toBeUndefined();
    expect(args.getSecret).not.toHaveBeenCalled();
  });

  it('skips a stored item whose id fails validation instead of reading its secrets', async () => {
    const args = makeArgs(NATIVE);
    args.configValues = {
      keys: { global: [{ id: 'BAD::ID', values: { label: 'x' } }] as never },
    };
    const result = await resolveConfig(args);
    expect(result.keys).toEqual([]);
    expect(args.getSecret).not.toHaveBeenCalled();
  });
});
