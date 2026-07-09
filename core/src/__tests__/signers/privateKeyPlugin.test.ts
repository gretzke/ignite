import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TxService } from '../../tx/TxService.js';
import { PrivateKeyPlugin } from '../../../../plugins/src/signer-provider/private-key/index.ts';

const PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const address = privateKeyToAccount(PK as `0x${string}`).address;
const config = { keys: [{ id: 'k1', label: 'dev', privateKey: PK }] };
const tx = {
  chainId: 31337,
  to: null,
  data: '0x00' as const,
  value: '0x0' as const,
  nonce: 0,
  gas: '0x186a0' as const,
  maxFeePerGas: '0x77359400' as const,
  maxPriorityFeePerGas: '0x3b9aca00' as const,
};

describe('PrivateKeyPlugin', () => {
  it('derives accounts from injected keys', async () => {
    const result = await new PrivateKeyPlugin().getAccounts({ config });
    expect(result).toEqual({
      success: true,
      data: {
        accounts: [
          { id: 'k1', address, label: 'dev', capability: 'sign-only' },
        ],
      },
    });
  });

  it('returns accounts:null when nothing is configured', async () => {
    const result = await new PrivateKeyPlugin().getAccounts({ config: {} });
    expect(result).toEqual({ success: true, data: { accounts: null } });
  });

  it('signs a tx that passes core integrity verification', async () => {
    const result = await new PrivateKeyPlugin().signTransaction({
      accountId: 'k1',
      tx,
      config,
    } as never);
    if (!result.success) throw new Error('sign failed');
    await expect(
      new TxService().verifySignedTx(result.data.rawTransaction, tx, address)
    ).resolves.toBeUndefined();
  });
});
