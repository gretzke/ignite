import { describe, it, expect } from 'vitest';
import {
  MnemonicPlugin,
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
  const config = { mnemonic: MNEMONIC, 'account-indices': '0,1' };

  it('derives the selected accounts', async () => {
    const result = await new MnemonicPlugin().getAccounts({ config });
    if (!result.success) throw new Error('failed');
    expect(result.data.accounts).toEqual([
      { id: '0', address: ADDR0, label: 'Account 0', capability: 'sign-only' },
      { id: '1', address: ADDR1, label: 'Account 1', capability: 'sign-only' },
    ]);
  });

  it('returns accounts:null without a mnemonic', async () => {
    const result = await new MnemonicPlugin().getAccounts({ config: {} });
    expect(result).toEqual({ success: true, data: { accounts: null } });
  });
});
