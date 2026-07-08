import os from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { resolveConfig } from '../../../plugins/config/resolveConfig.js';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import type { PermissionGrant } from '../../../plugins/trust/TrustManager.js';

function metadata(
  configFields: PluginMetadata['configFields']
): PluginMetadata {
  return {
    id: 'acme-plugin',
    type: PluginType.COMPILER,
    name: 'Acme',
    version: '1.0.0',
    baseImage: 'acme:latest',
    configFields,
  };
}

function grant(overrides: Partial<PermissionGrant> = {}): PermissionGrant {
  return {
    trust: 'trusted',
    hostWrite: false,
    net: false,
    secrets: [],
    ...overrides,
  };
}

describe('resolveConfig', () => {
  it('passes through non-secret string/number/boolean values', async () => {
    const result = await resolveConfig({
      metadata: metadata([
        { key: 'apiUrl', label: 'API URL', type: 'string' },
        { key: 'retries', label: 'Retries', type: 'number' },
        { key: 'verbose', label: 'Verbose', type: 'boolean' },
      ]),
      grant: grant(),
      configValues: {
        apiUrl: { global: 'https://example.com' },
        retries: { global: 3 },
        verbose: { global: true },
      },
      getSecret: vi.fn(),
    });

    expect(result).toEqual({
      apiUrl: 'https://example.com',
      retries: 3,
      verbose: true,
    });
  });

  it('merges a non-secret perChain field into a { default, [chainId] } shape', async () => {
    const result = await resolveConfig({
      metadata: metadata([
        { key: 'threshold', label: 'Threshold', type: 'number', perChain: true },
      ]),
      grant: grant(),
      configValues: {
        threshold: { global: 1, perChain: { '1': 10, '137': 137 } },
      },
      getSecret: vi.fn(),
    });

    expect(result).toEqual({
      threshold: { default: 1, '1': 10, '137': 137 },
    });
  });

  it('omits a perChain field entirely when there is no global and no perChain values', async () => {
    const result = await resolveConfig({
      metadata: metadata([
        { key: 'threshold', label: 'Threshold', type: 'number', perChain: true },
      ]),
      grant: grant(),
      configValues: {},
      getSecret: vi.fn(),
    });

    expect(result).toEqual({});
  });

  it('includes a secret field when the key is explicitly granted', async () => {
    const getSecret = vi.fn(async (key: string) =>
      key === 'apiKey' ? 'super-secret' : undefined
    );
    const result = await resolveConfig({
      metadata: metadata([
        { key: 'apiKey', label: 'API Key', type: 'string', secret: true },
      ]),
      grant: grant({ secrets: ['apiKey'] }),
      configValues: {},
      getSecret,
    });

    expect(result).toEqual({ apiKey: 'super-secret' });
    expect(getSecret).toHaveBeenCalledWith('apiKey');
  });

  it('omits a secret field that is NOT granted and never calls getSecret for it (security-critical)', async () => {
    const getSecret = vi.fn(async () => 'this-should-never-be-returned');
    const result = await resolveConfig({
      metadata: metadata([
        { key: 'apiKey', label: 'API Key', type: 'string', secret: true },
      ]),
      grant: grant({ secrets: [] }),
      configValues: {},
      getSecret,
    });

    expect(result).toEqual({});
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('grants all secrets under native trust regardless of the secrets list', async () => {
    const getSecret = vi.fn(async (key: string) => `value-of-${key}`);
    const result = await resolveConfig({
      metadata: metadata([
        { key: 'apiKey', label: 'API Key', type: 'string', secret: true },
        { key: 'otherKey', label: 'Other Key', type: 'string', secret: true },
      ]),
      grant: grant({ trust: 'native', secrets: [] }),
      configValues: {},
      getSecret,
    });

    expect(result).toEqual({
      apiKey: 'value-of-apiKey',
      otherKey: 'value-of-otherKey',
    });
  });

  it('omits fields that have no stored value', async () => {
    const result = await resolveConfig({
      metadata: metadata([{ key: 'apiUrl', label: 'API URL', type: 'string' }]),
      grant: grant(),
      configValues: {},
      getSecret: vi.fn(),
    });

    expect(result).toEqual({});
  });

  it('ignores values for keys not declared in the schema', async () => {
    const result = await resolveConfig({
      metadata: metadata([{ key: 'apiUrl', label: 'API URL', type: 'string' }]),
      grant: grant(),
      configValues: {
        apiUrl: { global: 'https://example.com' },
        undeclaredKey: { global: 'sneaky' },
      },
      getSecret: vi.fn(),
    });

    expect(result).toEqual({ apiUrl: 'https://example.com' });
  });

  it('builds a perChain secret map from getSecretChainIds + getSecret(key, chainId), including a default', async () => {
    const getSecret = vi.fn(async (key: string, chainId?: number) => {
      if (key !== 'apiKey') return undefined;
      if (chainId === undefined) return 'global-secret';
      if (chainId === 1) return 'chain-1-secret';
      if (chainId === 137) return 'chain-137-secret';
      return undefined;
    });
    const getSecretChainIds = vi.fn(async () => [1, 137]);

    const result = await resolveConfig({
      metadata: metadata([
        { key: 'apiKey', label: 'API Key', type: 'string', secret: true, perChain: true },
      ]),
      grant: grant({ secrets: ['apiKey'] }),
      configValues: {},
      getSecret,
      getSecretChainIds,
    });

    expect(result).toEqual({
      apiKey: { default: 'global-secret', '1': 'chain-1-secret', '137': 'chain-137-secret' },
    });
  });

  describe('file fields', () => {
    it('injects file contents under the field key when granted and a global path is configured', async () => {
      const getFileContents = vi.fn(async () => 'FILE CONTENTS');
      const result = await resolveConfig({
        metadata: metadata([
          {
            key: 'chainz-config',
            label: 'Config',
            type: 'file',
            default: '~/.chainz.json',
          },
        ]),
        grant: grant({ secrets: ['chainz-config'] }),
        configValues: { 'chainz-config': { global: '/custom/path.json' } },
        getSecret: vi.fn(),
        getFileContents,
      });

      expect(result).toEqual({ 'chainz-config': 'FILE CONTENTS' });
      expect(getFileContents).toHaveBeenCalledWith('/custom/path.json');
    });

    it('falls back to field.default and expands a leading ~ to os.homedir() when granted with no configured path', async () => {
      const getFileContents = vi.fn(async () => 'FILE CONTENTS');
      const result = await resolveConfig({
        metadata: metadata([
          {
            key: 'chainz-config',
            label: 'Config',
            type: 'file',
            default: '~/.chainz.json',
          },
        ]),
        grant: grant({ secrets: ['chainz-config'] }),
        configValues: {},
        getSecret: vi.fn(),
        getFileContents,
      });

      expect(result).toEqual({ 'chainz-config': 'FILE CONTENTS' });
      expect(getFileContents).toHaveBeenCalledWith(
        `${os.homedir()}/.chainz.json`
      );
    });

    it('never calls getFileContents for an ungranted file field (security-critical)', async () => {
      const getFileContents = vi.fn(async () => 'this-should-never-be-read');
      const result = await resolveConfig({
        metadata: metadata([
          {
            key: 'chainz-config',
            label: 'Config',
            type: 'file',
            default: '~/.chainz.json',
          },
        ]),
        grant: grant({ secrets: [] }),
        configValues: { 'chainz-config': { global: '/custom/path.json' } },
        getSecret: vi.fn(),
        getFileContents,
      });

      expect(result).toEqual({});
      expect(getFileContents).not.toHaveBeenCalled();
    });

    it('omits the field when granted but there is no configured path and no default', async () => {
      const getFileContents = vi.fn(async () => 'unreachable');
      const result = await resolveConfig({
        metadata: metadata([
          { key: 'chainz-config', label: 'Config', type: 'file' },
        ]),
        grant: grant({ secrets: ['chainz-config'] }),
        configValues: {},
        getSecret: vi.fn(),
        getFileContents,
      });

      expect(result).toEqual({});
      expect(getFileContents).not.toHaveBeenCalled();
    });

    it('omits the field when the file is unreadable (getFileContents resolves undefined)', async () => {
      const getFileContents = vi.fn(async () => undefined);
      const result = await resolveConfig({
        metadata: metadata([
          {
            key: 'chainz-config',
            label: 'Config',
            type: 'file',
            default: '~/.chainz.json',
          },
        ]),
        grant: grant({ secrets: ['chainz-config'] }),
        configValues: {},
        getSecret: vi.fn(),
        getFileContents,
      });

      expect(result).toEqual({});
    });

    it('grants a file field under native trust regardless of the secrets list, and leaves non-file fields unaffected', async () => {
      const getFileContents = vi.fn(async () => 'FILE CONTENTS');
      const result = await resolveConfig({
        metadata: metadata([
          {
            key: 'chainz-config',
            label: 'Config',
            type: 'file',
            default: '~/.chainz.json',
          },
          { key: 'apiUrl', label: 'API URL', type: 'string' },
        ]),
        grant: grant({ trust: 'native', secrets: [] }),
        configValues: { apiUrl: { global: 'https://example.com' } },
        getSecret: vi.fn(),
        getFileContents,
      });

      expect(result).toEqual({
        'chainz-config': 'FILE CONTENTS',
        apiUrl: 'https://example.com',
      });
    });
  });

  it('returns an empty object when configFields is empty or undefined', async () => {
    const emptyResult = await resolveConfig({
      metadata: metadata([]),
      grant: grant(),
      configValues: { apiUrl: { global: 'https://example.com' } },
      getSecret: vi.fn(),
    });
    expect(emptyResult).toEqual({});

    const undefinedResult = await resolveConfig({
      metadata: metadata(undefined),
      grant: grant(),
      configValues: { apiUrl: { global: 'https://example.com' } },
      getSecret: vi.fn(),
    });
    expect(undefinedResult).toEqual({});
  });
});
