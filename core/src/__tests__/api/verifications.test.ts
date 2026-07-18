import { describe, expect, it, vi } from 'vitest';
import { createVerificationHandlers } from '../../api/verifications.js';

function reply() {
  const result = { status: vi.fn(), send: vi.fn() };
  result.status.mockReturnValue(result);
  return result;
}

describe('manual contract-type verification', () => {
  it('rejects an installed descriptor whose hash or version drifted', async () => {
    const handlers = createVerificationHandlers({
      getProfileManager: async () => ({ getCurrentProfile: () => 'p' }),
      contractTypes: {
        frozenDescriptor: vi.fn(async () => ({ contentHash: 'b'.repeat(64), versionLabel: 'v2' })),
        getArtifact: vi.fn(),
      },
    } as never);
    const output = reply();
    await handlers.createVerification({ body: {
      contract: { id: 'proxy', origin: 'contract-type', pluginId: 'ct', artifactKey: 'proxy', contractName: 'Proxy', versionLabel: 'v1', contentHash: 'a'.repeat(64) },
      chainId: 1,
      address: '0x0000000000000000000000000000000000000001',
      explorerEntryIds: [],
    } } as never, output as never);
    expect(output.status).toHaveBeenCalledWith(409);
    expect(output.send).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CONTRACT_TYPE_DRIFT',
      details: expect.objectContaining({ expectedContentHash: 'a'.repeat(64), actualContentHash: 'b'.repeat(64) }),
    }));
  });
});
