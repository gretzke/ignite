import { afterEach, describe, expect, it, vi } from 'vitest';
import { contractTypeHandlers } from '../../api/contractTypes.js';
import { ContractTypeService } from '../../deployments/ContractTypeService.js';
import { IgniteError } from '../../types/errors.js';

function reply() {
  const result = { status: vi.fn(), send: vi.fn() };
  result.status.mockReturnValue(result);
  return result;
}

describe('contract type list API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds the frozen descriptor content hash to each discoverable type', async () => {
    const service = {
      list: vi.fn().mockResolvedValue([{ pluginId: 'proxy', label: 'Proxy' }]),
      frozenDescriptor: vi.fn().mockResolvedValue({ contentHash: 'a'.repeat(64) }),
    };
    vi.spyOn(ContractTypeService, 'getInstance').mockReturnValue(service as unknown as ContractTypeService);
    const output = reply();
    await contractTypeHandlers.listContractTypes({} as never, output as never);
    expect(output.status).toHaveBeenCalledWith(200);
    expect(output.send).toHaveBeenCalledWith({ data: { contractTypes: [{ pluginId: 'proxy', label: 'Proxy', contentHash: 'a'.repeat(64) }] } });
  });

  it('surfaces missing bytecode consent as a 403 before a source can be created', async () => {
    const service = {
      list: vi.fn().mockResolvedValue([{ pluginId: 'proxy' }]),
      frozenDescriptor: vi.fn().mockRejectedValue(new IgniteError('Contract-type plugin proxy is not granted contract bytecode permission', 'CONTRACT_BYTECODE_NOT_GRANTED')),
    };
    vi.spyOn(ContractTypeService, 'getInstance').mockReturnValue(service as unknown as ContractTypeService);
    const output = reply();
    await contractTypeHandlers.listContractTypes({} as never, output as never);
    expect(output.status).toHaveBeenCalledWith(403);
    expect(output.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'CONTRACT_BYTECODE_NOT_GRANTED' }));
  });
});
