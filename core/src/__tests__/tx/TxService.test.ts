import { describe, it, expect, vi } from 'vitest';
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

describe('TxService deployment execution extensions', () => {
  it('computes the pre-broadcast hash for a known signed transaction', async () => {
    const service = new TxService();
    expect(
      service.computeTxHash(
        '0x02f87583aa36a707843b9aca0084773594008252089470997970c51812dc3a010c7d01b50e0d17dc79c8880de0b6b3a764000080c080a034d291d61179b9417a1b0ac90229050bb8883392a8db5601d843969d62ceb099a054962bc88d9e15b3a5cea6d15d9b4770526c26f9e2b73f6b7af173a31cdd4895'
      )
    ).toBe(
      '0xb9c39dee99f8d93b5b163dcfe7724b9c1f2223a3a9ec7e804df980253ce8bff3'
    );
  });

  it('surfaces complete receipt data', async () => {
    const service = new TxService({
      createClient: () =>
        ({
          waitForTransactionReceipt: async () => ({
            status: 'success',
            blockNumber: 12n,
            contractAddress: unsigned.to,
            gasUsed: 42_000n,
            effectiveGasPrice: 2_000_000_000n,
          }),
        }) as never,
    });

    await expect(
      service.waitForReceipt('http://rpc.test', '0x1234')
    ).resolves.toEqual({
      status: 'success',
      blockNumber: 12,
      contractAddress: unsigned.to,
      gasUsed: '42000',
      effectiveGasPrice: '2000000000',
    });
  });

  it('uses supplied nonce and gas overrides without fetching those fields', async () => {
    const getTransactionCount = vi.fn();
    const estimateGas = vi.fn();
    const estimateFeesPerGas = vi.fn(async () => ({
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
    }));
    const service = new TxService({
      createClient: () =>
        ({ getTransactionCount, estimateGas, estimateFeesPerGas }) as never,
    });

    await expect(
      service.buildTransaction({
        rpcUrl: 'http://rpc.test',
        chainId: 1,
        from: account.address,
        to: null,
        value: 0n,
        data: '0x6001',
        overrides: {
          nonce: 7,
          gasLimit: 50_000n,
          maxFeePerGas: 30n,
        },
      })
    ).resolves.toMatchObject({
      nonce: 7,
      gas: '0xc350',
      maxFeePerGas: '0x1e',
      maxPriorityFeePerGas: '0x2',
    });
    expect(getTransactionCount).not.toHaveBeenCalled();
    expect(estimateGas).not.toHaveBeenCalled();
    expect(estimateFeesPerGas).toHaveBeenCalledOnce();
  });

  it('serializes work by chain and account without blocking other accounts', async () => {
    const service = new TxService();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = service.withAccountLock(1, account.address, async () => {
      events.push('first-start');
      await firstGate;
      events.push('first-end');
    });
    const second = service.withAccountLock(1, account.address, async () => {
      events.push('second-start');
    });
    const other = service.withAccountLock(1, unsigned.to, async () => {
      events.push('other-start');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain('first-start');
    expect(events).toContain('other-start');
    expect(events).not.toContain('second-start');
    releaseFirst();
    await Promise.all([first, second, other]);
    expect(events).toEqual([
      'first-start',
      'other-start',
      'first-end',
      'second-start',
    ]);
  });
});
