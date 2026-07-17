// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ChainInfo, ExplorerTargetSnapshot } from '@ignite/api';
import { explorerAddressUrl, explorerTxUrl } from '../explorerLinks';

const address = '0x0000000000000000000000000000000000000001';
const hash = `0x${'1'.repeat(64)}`;
const target = { entryId: 'sourcify', url: 'https://repo.sourcify.dev', verifierPluginId: 'sourcify', label: 'Sourcify', pageUrlTemplate: 'https://repo.sourcify.dev/contracts/{address}' } as ExplorerTargetSnapshot;

describe('explorer links', () => {
  it('uses the first EIP-3091 explorer with normalized slashes', () => {
    const chain = { explorers: [{ name: 'Etherscan', url: 'https://etherscan.io/', standard: 'EIP3091' }] } as ChainInfo;
    expect(explorerAddressUrl(chain, [target], address)).toBe(`https://etherscan.io/address/${address}`);
    expect(explorerTxUrl(chain, hash)).toBe(`https://etherscan.io/tx/${hash}`);
  });

  it('only falls back to address templates and leaves unsupported links undefined', () => {
    expect(explorerAddressUrl(undefined, [target], address)).toBe(`https://repo.sourcify.dev/contracts/${address}`);
    expect(explorerTxUrl(undefined, hash)).toBeUndefined();
    expect(explorerAddressUrl(undefined, [], address)).toBeUndefined();
  });
});
