import { describe, expect, it, vi } from 'vitest';
import {
  PluginType,
  type PluginMetadata,
  type PluginResponse,
} from '@ignite/plugin-types/types';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { PluginInvoker } from '../../plugins/invoke/PluginInvoker.js';
import { ErrorCodes } from '../../types/errors.js';

function makeConfig(overrides?: {
  runtime?: 'container' | 'frontend';
  origin?: 'builtin' | 'installed';
}): PluginConfig {
  const metadata: PluginMetadata = {
    id: 'browser-wallet',
    name: 'Browser Wallet',
    version: '1.0.0',
    baseImage: '',
    runtime: overrides?.runtime ?? 'frontend',
    types: [PluginType.SIGNER_PROVIDER],
    permissions: [],
    configFields: [],
  };
  return {
    metadata,
    repoRead: false,
    origin: overrides?.origin ?? 'builtin',
  };
}

describe('PluginInvoker frontend runtime', () => {
  it.each([
    ['getAccounts', 15_000],
    ['sendTransaction', 120_000],
    ['connect', 120_000],
    ['otherOperation', 30_000],
  ])(
    'routes builtin frontend %s through the bridge',
    async (operation, timeoutMs) => {
      const signal = new AbortController().signal;
      const bridge = {
        request: vi.fn(
          async (): Promise<PluginResponse<unknown>> => ({
            success: true,
            data: { ok: true },
          })
        ),
      };
      const executeContainer = vi.fn();
      const invoker = new PluginInvoker({
        registryLoader: {
          getPluginConfig: async () => makeConfig(),
        },
        executeContainer,
        bridge,
      });

      await expect(
        invoker.invoke('browser-wallet', operation, { input: true }, { signal })
      ).resolves.toEqual({ success: true, data: { ok: true } });

      expect(bridge.request).toHaveBeenCalledWith(
        'browser-wallet',
        operation,
        { input: true },
        { signal, timeoutMs }
      );
      expect(executeContainer).not.toHaveBeenCalled();
    }
  );

  it('rejects installed frontend plugins before they can reach the bridge', async () => {
    const bridge = {
      request: vi.fn(),
    };
    const invoker = new PluginInvoker({
      registryLoader: {
        getPluginConfig: async () => makeConfig({ origin: 'installed' }),
      },
      executeContainer: vi.fn(),
      bridge,
    });

    await expect(
      invoker.invoke('browser-wallet', 'getAccounts', {})
    ).resolves.toEqual({
      success: false,
      error: {
        code: ErrorCodes.PERMISSION_REQUIRED,
        message: 'Installed plugins cannot use the frontend runtime.',
      },
    });
    expect(bridge.request).not.toHaveBeenCalled();
  });
});
