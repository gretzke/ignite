import { describe, expect, it } from 'vitest';
import {
  ensureChain,
  makeAccountId,
  providerDetailForTest,
  sendTransactionWithProviders,
  splitAccountId,
  type Eip1193Provider,
  type SendTransactionParams,
} from '../../../../plugins/src/signer-provider/browser-wallet/index.ts';

class ScriptedProvider implements Eip1193Provider {
  readonly calls: { method: string; params?: unknown[] | object }[] = [];
  constructor(
    private handlers: Record<
      string,
      | unknown
      | ((args: { method: string; params?: unknown[] | object }) => unknown)
    >
  ) {}

  async request(args: {
    method: string;
    params?: unknown[] | object;
  }): Promise<unknown> {
    this.calls.push(args);
    const handler = this.handlers[args.method];
    if (typeof handler === 'function') {
      return handler(args);
    }
    return handler;
  }
}

const chain = {
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};
const address = '0x1234567890abcdef1234567890abcdef12345678' as const;
const txParams: SendTransactionParams = {
  accountId: makeAccountId('io.metamask~metamask', address),
  rpcUrl: 'http://127.0.0.1:8545',
  chain,
  tx: {
    chainId: 31337,
    to: '0x0000000000000000000000000000000000000001',
    data: '0x',
    value: '0x1',
    nonce: 0,
    gas: '0x5208',
    maxFeePerGas: '0x1',
    maxPriorityFeePerGas: '0x1',
  },
};

describe('browser-wallet ensureChain', () => {
  it('does nothing when the wallet is already on the requested chain', async () => {
    const provider = new ScriptedProvider({ eth_chainId: '0x7a69' });
    await ensureChain(provider, 31337, txParams.rpcUrl, chain);
    expect(provider.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('switches when the chain is known to the wallet', async () => {
    const provider = new ScriptedProvider({
      eth_chainId: '0x1',
      wallet_switchEthereumChain: null,
    });
    await ensureChain(provider, 31337, txParams.rpcUrl, chain);
    expect(provider.calls).toMatchObject([
      { method: 'eth_chainId' },
      {
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x7a69' }],
      },
    ]);
  });

  it('adds then switches when the wallet reports an unknown chain', async () => {
    let switchAttempts = 0;
    const provider = new ScriptedProvider({
      eth_chainId: '0x1',
      wallet_switchEthereumChain: () => {
        switchAttempts += 1;
        if (switchAttempts === 1) {
          throw Object.assign(new Error('unknown chain'), { code: 4902 });
        }
        return null;
      },
      wallet_addEthereumChain: null,
    });
    await ensureChain(provider, 31337, txParams.rpcUrl, chain);
    expect(provider.calls.map((c) => c.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ]);
    expect(provider.calls[2].params).toEqual([
      {
        chainId: '0x7a69',
        chainName: 'Anvil',
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [txParams.rpcUrl],
      },
    ]);
  });

  it('propagates a user-rejected chain switch for caller mapping', async () => {
    const provider = new ScriptedProvider({
      eth_chainId: '0x1',
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error('rejected'), { code: 4001 });
      },
    });
    await expect(
      ensureChain(provider, 31337, txParams.rpcUrl, chain)
    ).rejects.toMatchObject({ code: 4001 });
  });
});

describe('browser-wallet sendTransaction', () => {
  it('sends through the selected wallet provider', async () => {
    const provider = new ScriptedProvider({
      eth_chainId: '0x7a69',
      eth_sendTransaction: '0xabc',
    });
    const result = await sendTransactionWithProviders(
      txParams,
      new Map([
        [
          'io.metamask~metamask',
          providerDetailForTest('io.metamask', 'MetaMask', provider),
        ],
      ])
    );
    expect(result).toEqual({ success: true, data: { txHash: '0xabc' } });
    expect(provider.calls[1]).toEqual({
      method: 'eth_sendTransaction',
      params: [
        {
          from: address,
          to: txParams.tx.to,
          value: txParams.tx.value,
          data: txParams.tx.data,
          gas: txParams.tx.gas,
        },
      ],
    });
  });

  it('maps transaction rejection to USER_REJECTED', async () => {
    const provider = new ScriptedProvider({
      eth_chainId: '0x7a69',
      eth_sendTransaction: () => {
        throw Object.assign(new Error('denied'), { code: 4001 });
      },
    });
    const result = await sendTransactionWithProviders(
      txParams,
      new Map([
        [
          'io.metamask~metamask',
          providerDetailForTest('io.metamask', 'MetaMask', provider),
        ],
      ])
    );
    expect(result).toEqual({
      success: false,
      error: { code: 'USER_REJECTED', message: 'Transaction was rejected' },
    });
  });

  it('returns WALLET_NOT_FOUND for an unknown provider id', async () => {
    const result = await sendTransactionWithProviders(txParams, new Map());
    expect(result).toEqual({
      success: false,
      error: {
        code: 'WALLET_NOT_FOUND',
        message: 'Wallet account is no longer available',
      },
    });
  });

  it('round-trips account ids by splitting on the first separator', () => {
    const accountId = makeAccountId('io.metamask~metamask', address);
    expect(splitAccountId(accountId)).toEqual({
      rdns: 'io.metamask~metamask',
      address,
    });
  });

  it('names the migration path for a pre-disambiguation account id', async () => {
    const provider = new ScriptedProvider({});
    const result = await sendTransactionWithProviders(
      { ...txParams, accountId: `io.metamask:${address}` },
      new Map([
        [
          'io.metamask~metamask',
          providerDetailForTest('io.metamask', 'MetaMask', provider),
        ],
      ])
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'WALLET_NOT_FOUND' },
    });
    expect(
      !result.success &&
        result.error.message.includes('older wallet identifier')
    ).toBe(true);
  });
});
