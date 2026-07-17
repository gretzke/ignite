import { describe, expect, it } from 'vitest';
import { PluginMetadataSchema } from '@ignite/api';
import { PluginType } from '@ignite/plugin-types/types';

describe('plugin metadata schema', () => {
  it('accepts contract-bytecode permissions declared by the transparent proxy plugin', () => {
    expect(PluginMetadataSchema.parse({ id: 'oz-transparent', types: [PluginType.CONTRACT_TYPE], name: 'Transparent proxy', version: '1', baseImage: 'ignite/oz-transparent', permissions: [{ id: 'contractBytecode', description: 'Supplies OpenZeppelin proxy bytecode' }], operations: ['describeContractType', 'getContractArtifact'] })).toMatchObject({ permissions: [{ id: 'contractBytecode' }] });
  });
});
