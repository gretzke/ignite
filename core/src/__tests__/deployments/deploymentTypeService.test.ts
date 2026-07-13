import { describe, expect, it, vi } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginConfig } from '../../assets/PluginRegistryLoader.js';
import { DeploymentTypeService } from '../../deployments/DeploymentTypeService.js';

const config: PluginConfig = {
  origin: 'installed',
  repoRead: false,
  metadata: {
    id: 'hook', types: [PluginType.DEPLOYMENT_TYPE], name: 'Hook', version: '1',
    baseImage: 'ignite/hook', operations: ['describeDeploymentType', 'prepareDeployment', 'validateDeployment'],
  },
};
const hex32 = `0x${'11'.repeat(32)}` as `0x${string}`;

describe('DeploymentTypeService', () => {
  it('describes deployment types with none scope and caches the result', async () => {
    const execute = vi.fn(async () => ({ success: true as const, data: {
      label: 'Hook\u0000', description: 'A hook\n', params: [{ key: 'flags', label: 'Flags', type: 'string' }],
    } }));
    const service = new DeploymentTypeService({ getProviders: vi.fn(async () => [config]), execute });
    await expect(service.list()).resolves.toEqual([{
      pluginId: 'hook', label: 'Hook', description: 'A hook\n',
      params: [{ key: 'flags', label: 'Flags', type: 'string' }], validateSupported: true,
    }]);
    await service.list();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('hook', 'describeDeploymentType', {}, { chainScope: 'none' });
  });

  it('passes the canonical proxy and rejects unknown parameter keys before dispatch', async () => {
    const execute = vi.fn(async (_id: string, operation: string) => {
      if (operation === 'describeDeploymentType') return { success: true as const, data: { label: 'Hook', description: 'Desc', params: [{ key: 'flags', label: 'Flags', type: 'string' }] } };
      return { success: true as const, data: { salt: hex32, predictedAddress: '0x1111111111111111111111111111111111111111', notes: [] } };
    });
    const service = new DeploymentTypeService({ getProviders: async () => [config], execute });
    await service.prepare('hook', { chainId: 1, initcode: '0x00', params: { flags: '1' } });
    expect(execute).toHaveBeenLastCalledWith('hook', 'prepareDeployment', expect.objectContaining({ proxyAddress: '0x4e59b44847b379578588920cA78FbF26c0B4956C' }), { chainScope: 1 });
    await expect(service.prepare('hook', { chainId: 1, initcode: '0x00', params: { no: '1' } })).rejects.toMatchObject({ code: 'UNKNOWN_PARAM_KEY' });
  });

  it('rejects a malformed plugin result as a typed operation failure', async () => {
    const service = new DeploymentTypeService({
      getProviders: async () => [config],
      execute: async () => ({ success: true, data: { label: 'x'.repeat(65), description: 'd', params: [] } }),
    });
    await expect(service.list()).rejects.toMatchObject({ code: 'DEPLOYMENT_TYPE_OP_FAILED' });
  });
});
