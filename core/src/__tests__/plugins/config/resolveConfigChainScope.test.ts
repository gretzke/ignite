import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../../plugins/config/resolveConfig.js';

const metadata = {
  id: 'verifier',
  name: 'Verifier',
  version: '1',
  types: [],
  configFields: [
    { key: 'apiKey', label: 'Key', type: 'text', secret: true, perChain: true },
    { key: 'apiUrl', label: 'URL', type: 'text', perChain: true },
  ],
} as any;
const grant = {
  trust: 'native',
  net: true,
  repoWrite: true,
  secrets: [],
} as any;

describe('resolveConfig chainScope', () => {
  it('narrows per-chain secrets and non-secret values to the target chain', async () => {
    const getSecret = vi.fn(async (_key: string, chainId?: number) =>
      chainId === undefined ? 'default' : `key-${chainId}`
    );
    const result = await resolveConfig({
      metadata,
      grant,
      configValues: {
        apiUrl: {
          global: 'https://default',
          perChain: { '1': 'https://one', '10': 'https://ten' },
        },
      },
      getSecret,
      getSecretChainIds: async () => [1, 10],
      opts: { chainScope: 1 },
    });
    expect(result).toEqual({
      apiKey: { default: 'default', '1': 'key-1' },
      apiUrl: { default: 'https://default', '1': 'https://one' },
    });
    expect(getSecret).not.toHaveBeenCalledWith('apiKey', 10);
  });
  it('keeps the full map without a chain scope', async () => {
    const result = await resolveConfig({
      metadata,
      grant,
      configValues: {
        apiUrl: {
          global: 'https://default',
          perChain: { '1': 'https://one', '10': 'https://ten' },
        },
      },
      getSecret: async (_key: string, chainId?: number) =>
        chainId === undefined ? 'default' : `key-${chainId}`,
      getSecretChainIds: async () => [1, 10],
    });
    expect(result).toEqual({
      apiKey: { default: 'default', '1': 'key-1', '10': 'key-10' },
      apiUrl: {
        default: 'https://default',
        '1': 'https://one',
        '10': 'https://ten',
      },
    });
  });
});
