// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ExplorerEntry } from '@ignite/api';
import { explorerBlocker } from '../DeployWizardPage';
import {
  deployDraftReducer,
  setExplorerSelection,
} from '../../../store/features/deployments/deployDraftSlice';
import {
  explorerReceived,
  explorersReducer,
} from '../../../store/features/explorers/explorersSlice';

const entry: ExplorerEntry = {
  id: 'scan',
  chainId: 1,
  url: 'https://etherscan.io',
  source: 'manual',
  label: 'Etherscan',
};

describe('explorer wizard behavior', () => {
  it('only blocks selected explorer entries that need mapping or config', () => {
    const name = () => 'Ethereum';
    expect(explorerBlocker([1], {}, { '1': [entry] }, name)).toBeUndefined();
    expect(
      explorerBlocker([1], { '1': ['scan'] }, { '1': [entry] }, name)
    ).toBe('Ethereum: Etherscan needs a verifier type');
    expect(
      explorerBlocker(
        [1],
        { '1': ['scan'] },
        { '1': [{ ...entry, verifierPluginId: 'etherscan', needsConfig: true }] },
        name
      )
    ).toBe('Ethereum: Etherscan needs configuration');
  });

  it('keeps selection in the deployment draft and stores confirmed mappings', () => {
    const draft = deployDraftReducer(
      undefined,
      setExplorerSelection({ '1': ['scan'] })
    );
    expect(draft.explorerSelection).toEqual({ '1': ['scan'] });
    let explorers = explorersReducer(undefined, explorerReceived(entry));
    explorers = explorersReducer(
      explorers,
      explorerReceived({ ...entry, verifierPluginId: 'etherscan' })
    );
    expect(explorers.byChain['1']?.[0].verifierPluginId).toBe('etherscan');
  });
});
