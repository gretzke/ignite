import { beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { SignerProviderService } from '../../signers/SignerProviderService.js';
import { TxService } from '../../tx/TxService.js';
import type { PluginResponse } from '@ignite/plugin-types/types';

const PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const signerAccount = privateKeyToAccount(PK);
const VALID = {
  id: 'k1',
  address: signerAccount.address,
  label: 'dev',
  capability: 'sign-only' as const,
};

function makeService(overrides?: {
  getProviders?: () => Promise<
    { id: string; name: string; runtime?: 'container' | 'frontend' }[]
  >;
  invoke?: (
    pluginId: string,
    op: string,
    params: Record<string, unknown>
  ) => Promise<PluginResponse<unknown>>;
  hasFrontendHost?: (pluginId: string) => boolean;
  txService?: Partial<TxService>;
}) {
  SignerProviderService.resetInstance();
  return new SignerProviderService({
    getProviders:
      overrides?.getProviders ??
      (async () => [
        { id: 'private-key', name: 'Private Key' },
        { id: 'broken', name: 'Broken' },
      ]),
    invoke:
      overrides?.invoke ??
      (async (pluginId) =>
        pluginId === 'private-key'
          ? { success: true, data: { accounts: [VALID] } }
          : { success: false, error: { code: 'X', message: 'boom' } }),
    txService: (overrides?.txService as TxService) ?? new TxService(),
    hasFrontendHost: overrides?.hasFrontendHost ?? (() => false),
    logger: { warn: vi.fn() },
    now: () => 0,
    timeoutMs: 1000,
  });
}

describe('SignerProviderService.listAccounts', () => {
  beforeEach(() => {
    SignerProviderService.resetInstance();
  });

  it('isolates a broken provider and validates good entries', async () => {
    const svc = makeService();
    const data = await svc.listAccounts();
    const ok = data.providers.find((p) => p.pluginId === 'private-key');
    const broken = data.providers.find((p) => p.pluginId === 'broken');
    expect(ok?.state).toBe('ok');
    expect(ok?.accounts).toEqual([VALID]);
    expect(broken?.state).toBe('error');
    expect(broken?.accounts).toEqual([]);
  });

  it('maps accounts:null to needs-config and drops malformed entries', async () => {
    const svc = makeService({
      invoke: async (pluginId) =>
        pluginId === 'private-key'
          ? { success: true, data: { accounts: null } }
          : {
              success: true,
              data: {
                accounts: [
                  { id: 'bad', address: 'not-hex', capability: 'sign-only' },
                  VALID,
                ],
              },
            },
    });
    const data = await svc.listAccounts();
    expect(
      data.providers.find((p) => p.pluginId === 'private-key')?.state
    ).toBe('needs-config');
    const other = data.providers.find((p) => p.pluginId === 'broken');
    expect(other?.accounts).toEqual([VALID]);
  });

  it('marks frontend-runtime providers as needs-browser when no host is live', async () => {
    const invoke = vi.fn();
    const svc = makeService({
      getProviders: async () => [
        { id: 'wallet-browser', name: 'Wallet', runtime: 'frontend' },
      ],
      invoke,
      hasFrontendHost: () => false,
    });
    await expect(svc.listAccounts()).resolves.toEqual({
      providers: [
        {
          pluginId: 'wallet-browser',
          name: 'Wallet',
          state: 'needs-browser',
          accounts: [],
        },
      ],
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fetches and validates frontend accounts when a browser host is live', async () => {
    const invoke = vi.fn(
      async (): Promise<PluginResponse<unknown>> => ({
        success: true,
        data: { accounts: [VALID] },
      })
    );
    const svc = makeService({
      getProviders: async () => [
        { id: 'wallet-browser', name: 'Wallet', runtime: 'frontend' },
      ],
      invoke,
      hasFrontendHost: (pluginId) => pluginId === 'wallet-browser',
    });

    await expect(svc.listAccounts()).resolves.toEqual({
      providers: [
        {
          pluginId: 'wallet-browser',
          name: 'Wallet',
          state: 'ok',
          accounts: [VALID],
        },
      ],
    });
    expect(invoke).toHaveBeenCalledWith(
      'wallet-browser',
      'getAccounts',
      {},
      expect.any(Object)
    );
  });

  it('does not cache frontend account results across sequential list calls', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        data: { accounts: [{ ...VALID, id: 'first' }] },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { accounts: [{ ...VALID, id: 'second' }] },
      });
    const svc = makeService({
      getProviders: async () => [
        { id: 'wallet-browser', name: 'Wallet', runtime: 'frontend' },
      ],
      invoke,
      hasFrontendHost: () => true,
    });

    await expect(svc.listAccounts()).resolves.toMatchObject({
      providers: [{ accounts: [{ id: 'first' }] }],
    });
    await expect(svc.listAccounts()).resolves.toMatchObject({
      providers: [{ accounts: [{ id: 'second' }] }],
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe('SignerProviderService.send (sign-only path)', () => {
  it('builds, signs via the plugin, verifies, broadcasts, waits', async () => {
    const broadcast = vi.fn(async () => '0x1234' as const);
    const waitForReceipt = vi.fn(async () => ({
      status: 'success' as const,
      blockNumber: 1,
      contractAddress: null,
      gasUsed: '21000',
      effectiveGasPrice: '1000000000',
    }));
    const buildTransaction = vi.fn(async () => ({
      chainId: 31337,
      to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const,
      data: '0x' as const,
      value: '0x0' as const,
      nonce: 0,
      gas: '0x5208' as const,
      maxFeePerGas: '0x77359400' as const,
      maxPriorityFeePerGas: '0x3b9aca00' as const,
    }));
    const realTx = new TxService();
    const svc = makeService({
      invoke: async (_pluginId, op, params) => {
        if (op === 'getAccounts') {
          return { success: true, data: { accounts: [VALID] } };
        }
        const tx = (params as { tx: Parameters<typeof toViem>[0] }).tx;
        const raw = await signerAccount.signTransaction(toViem(tx));
        return { success: true, data: { rawTransaction: raw } };
      },
      txService: {
        buildTransaction,
        verifySignedTx: realTx.verifySignedTx.bind(realTx),
        broadcast,
        waitForReceipt,
        withAccountLock: async (_chainId, _address, fn) => fn(),
      },
    });
    const result = await svc.send(
      {
        pluginId: 'private-key',
        accountId: 'k1',
        chainId: 31337,
        rpcUrl: 'http://localhost:8545',
        chain: {
          name: 'Anvil',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        },
        to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        value: 0n,
        data: '0x',
      },
      { log: () => {}, signal: new AbortController().signal }
    );
    expect(broadcast).toHaveBeenCalled();
    expect(result).toEqual({
      txHash: '0x1234',
      status: 'success',
      blockNumber: 1,
    });
  });
});

describe('SignerProviderService.executeTx', () => {
  const tx = {
    chainId: 31337,
    to: null,
    data: '0x6001' as const,
    value: '0x0' as const,
    nonce: 0,
    gas: '0xc350' as const,
    maxFeePerGas: '0x1e' as const,
    maxPriorityFeePerGas: '0x2' as const,
  };
  const executeArgs = {
    pluginId: 'private-key',
    accountId: 'k1',
    chainId: 31337,
    rpcUrl: 'http://localhost:8545',
    chain: {
      name: 'Anvil',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    },
    to: null,
    value: 0n,
    data: '0x6001' as const,
    expectedAddress: signerAccount.address,
  };

  it('rejects when the provider account no longer matches the selected address', async () => {
    const buildTransaction = vi.fn();
    const svc = makeService({
      txService: { buildTransaction },
    });

    await expect(
      svc.executeTx(
        {
          ...executeArgs,
          expectedAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        },
        { log: () => {}, signal: new AbortController().signal }
      )
    ).rejects.toMatchObject({ code: 'SIGNER_ADDRESS_MISMATCH' });
    expect(buildTransaction).not.toHaveBeenCalled();
  });

  it('awaits the broadcast phase before sign-and-send submission', async () => {
    const sendTransaction = vi.fn(async () => ({
      success: true as const,
      data: { txHash: '0x1234' },
    }));
    let releasePhase!: () => void;
    const phaseGate = new Promise<void>((resolve) => {
      releasePhase = resolve;
    });
    const svc = makeService({
      invoke: async (_pluginId, operation) => {
        if (operation === 'getAccounts') {
          return {
            success: true,
            data: { accounts: [{ ...VALID, capability: 'sign-and-send' }] },
          };
        }
        return sendTransaction();
      },
      txService: {
        buildTransaction: async () => tx,
        withAccountLock: async (_chainId, _address, fn) => fn(),
        getBalance: async () => 1_000_000_000n,
        waitForReceipt: async () => ({
          status: 'success',
          blockNumber: 1,
          contractAddress: signerAccount.address,
          gasUsed: '1',
          effectiveGasPrice: '2',
        }),
      },
    });

    const execution = svc.executeTx(
      {
        ...executeArgs,
        onPhase: async (phase) => {
          if (phase === 'broadcasting') await phaseGate;
        },
      },
      { log: () => {}, signal: new AbortController().signal }
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(sendTransaction).not.toHaveBeenCalled();
    releasePhase();
    await expect(execution).resolves.toMatchObject({ txHash: '0x1234' });
    expect(sendTransaction).toHaveBeenCalledOnce();
  });

  it('does not submit when the broadcast phase persistence rejects', async () => {
    const sendTransaction = vi.fn();
    const svc = makeService({
      invoke: async (_pluginId, operation) =>
        operation === 'getAccounts'
          ? {
              success: true,
              data: { accounts: [{ ...VALID, capability: 'sign-and-send' }] },
            }
          : sendTransaction(),
      txService: {
        buildTransaction: async () => tx,
        withAccountLock: async (_chainId, _address, fn) => fn(),
      },
    });

    await expect(
      svc.executeTx(
        {
          ...executeArgs,
          onPhase: async () => Promise.reject(new Error('write failed')),
        },
        { log: () => {}, signal: new AbortController().signal }
      )
    ).rejects.toThrow('write failed');
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});

function toViem(tx: {
  chainId: number;
  to: `0x${string}` | null;
  data: `0x${string}`;
  value: `0x${string}`;
  nonce: number;
  gas: `0x${string}`;
  maxFeePerGas: `0x${string}`;
  maxPriorityFeePerGas: `0x${string}`;
}) {
  return {
    chainId: tx.chainId,
    to: tx.to ?? undefined,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    type: 'eip1559' as const,
  };
}
