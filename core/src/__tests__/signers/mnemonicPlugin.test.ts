import { describe, it, expect } from 'vitest';
import {
  MnemonicPlugin,
  makeAccountId,
  parseIndices,
} from '../../../../plugins/src/signer-provider/mnemonic/index.ts';

const MNEMONIC = 'test test test test test test test test test test test junk';
const ADDR0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ADDR1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('parseIndices', () => {
  it('parses ranges and singles, deduped and sorted', () => {
    expect(parseIndices('0-2,7,1')).toEqual([0, 1, 2, 7]);
  });

  it('rejects garbage and caps range width', () => {
    expect(parseIndices('abc')).toEqual([]);
    expect(parseIndices('0-9999')).toEqual([]);
  });
});

describe('MnemonicPlugin', () => {
  const config = {
    mnemonics: [
      { id: 'anvildev1', label: 'anvil dev', mnemonic: MNEMONIC, 'account-indices': '0,1' },
      { id: 'other001', label: 'other', mnemonic: MNEMONIC },
    ],
  };

  it('derives the selected accounts across list items', async () => {
    const result = await new MnemonicPlugin().getAccounts({ config });
    if (!result.success) throw new Error('failed');
    expect(result.data.accounts).toEqual([
      {
        id: makeAccountId('anvildev1', 0),
        address: ADDR0,
        label: 'anvil dev #0',
        capability: 'sign-only',
      },
      {
        id: makeAccountId('anvildev1', 1),
        address: ADDR1,
        label: 'anvil dev #1',
        capability: 'sign-only',
      },
      {
        id: makeAccountId('other001', 0),
        address: ADDR0,
        label: 'other #0',
        capability: 'sign-only',
      },
    ]);
  });

  it('returns accounts:null with no configured items', async () => {
    const result = await new MnemonicPlugin().getAccounts({ config: {} });
    expect(result).toEqual({ success: true, data: { accounts: null } });
  });

  it('skips a malformed phrase without hiding other items', async () => {
    const result = await new MnemonicPlugin().getAccounts({
      config: {
        mnemonics: [
          { id: 'broken01', label: 'broken', mnemonic: 'not a phrase' },
          { id: 'good0001', label: 'good', mnemonic: MNEMONIC },
        ],
      },
    });
    if (!result.success) throw new Error('failed');
    expect(result.data.accounts).toEqual([
      {
        id: makeAccountId('good0001', 0),
        address: ADDR0,
        label: 'good #0',
        capability: 'sign-only',
      },
    ]);
  });

  it('rejects signing for an index outside the configured set', async () => {
    const result = await new MnemonicPlugin().signTransaction({
      accountId: makeAccountId('anvildev1', 9),
      config,
      tx: {
        chainId: 1,
        to: null,
        data: '0x',
        value: '0',
        nonce: 0,
        gas: '21000',
        maxFeePerGas: '1',
        maxPriorityFeePerGas: '1',
      },
    } as never);
    expect(result.success).toBe(false);
  });
});
