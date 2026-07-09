import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TxService, toUnsignedTx } from '../../tx/TxService.js';

// anvil's well-known dev key #0
const PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const account = privateKeyToAccount(PK);

type TestUnsignedTx = {
  chainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
  nonce: number;
  gas: `0x${string}`;
  maxFeePerGas: `0x${string}`;
  maxPriorityFeePerGas: `0x${string}`;
};

const unsigned: TestUnsignedTx = {
  chainId: 11155111,
  to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const,
  data: '0x' as const,
  value: '0xde0b6b3a7640000' as const, // 1 ether
  nonce: 7,
  gas: '0x5208' as const,
  maxFeePerGas: '0x77359400' as const,
  maxPriorityFeePerGas: '0x3b9aca00' as const,
};

async function signUnsigned(tx: TestUnsignedTx) {
  return account.signTransaction({
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    type: 'eip1559',
  });
}

describe('TxService.verifySignedTx', () => {
  it('accepts a faithful signature from the right account', async () => {
    const raw = await signUnsigned(unsigned);
    const svc = new TxService();
    await expect(
      svc.verifySignedTx(raw, unsigned, account.address)
    ).resolves.toBeUndefined();
  });

  it('rejects when a field was tampered with', async () => {
    const raw = await signUnsigned({
      ...unsigned,
      to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    });
    const svc = new TxService();
    await expect(
      svc.verifySignedTx(raw, unsigned, account.address)
    ).rejects.toThrow(/mismatch/i);
  });

  it('rejects when signed by a different key', async () => {
    const raw = await signUnsigned(unsigned);
    const svc = new TxService();
    await expect(
      svc.verifySignedTx(
        raw,
        unsigned,
        '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
      )
    ).rejects.toThrow(/signer/i);
  });
});

describe('toUnsignedTx', () => {
  it('hex-encodes bigint quantities', () => {
    expect(
      toUnsignedTx({
        chainId: 1,
        to: null,
        data: '0x6001',
        value: 0n,
        nonce: 0,
        gas: 21000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      })
    ).toEqual({
      chainId: 1,
      to: null,
      data: '0x6001',
      value: '0x0',
      nonce: 0,
      gas: '0x5208',
      maxFeePerGas: '0x77359400',
      maxPriorityFeePerGas: '0x3b9aca00',
    });
  });
});
