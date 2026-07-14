import { describe, expect, it, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import { DescribeDeploymentHookResultSchema, OnRunCompletedResultSchema, SuggestAddressesResultSchema } from '@ignite/api';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { DeploymentHookService } from '../../deployments/DeploymentHookService.js';

const config: PluginConfig = {
  origin: 'installed', repoRead: false,
  metadata: { id: 'chronicles', types: [PluginType.DEPLOYMENT_HOOK], name: 'Chronicles', version: '1', baseImage: 'ignite/chronicles', operations: ['describeDeploymentHook', 'onRunCompleted', 'suggestAddresses'] },
};

describe('DeploymentHookService', () => {
  it('describes deployment hooks with none scope, strips controls, and caches', async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: { label: 'Chron\u0000icles', description: 'Writes history\u0007' } }));
    const service = new DeploymentHookService({ getProviders: vi.fn(async () => [config]), execute });
    await expect(service.list()).resolves.toEqual([{ pluginId: 'chronicles', label: 'Chronicles', description: 'Writes history' }]);
    await service.list();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('chronicles', 'describeDeploymentHook', {}, { chainScope: 'none' });
  });

  it('rejects malformed or oversized describe results with a typed error', async () => {
    const service = new DeploymentHookService({ getProviders: async () => [config], execute: async () => ({ success: true, data: { label: 'x'.repeat(65), description: 'bad' } }) });
    await expect(service.list()).rejects.toMatchObject({ code: 'DEPLOYMENT_HOOK_OP_FAILED' });
  });

  it('pins hook operation wire caps', () => {
    expect(() => DescribeDeploymentHookResultSchema.parse({ label: 'x'.repeat(65), description: 'ok' })).toThrow();
    expect(() => OnRunCompletedResultSchema.parse({ notes: Array.from({ length: 9 }, () => 'note') })).toThrow();
    expect(() => SuggestAddressesResultSchema.parse({ suggestions: Array.from({ length: 65 }, () => ({ chainId: 1, address: '0x1111111111111111111111111111111111111111' })) })).toThrow();
    expect(SuggestAddressesResultSchema.parse({ suggestions: [{ chainId: 1, address: '0x1111111111111111111111111111111111111111', label: 'Known' }] }).suggestions).toHaveLength(1);
  });
});
