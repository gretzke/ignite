import { useEffect } from 'react';
import { apiClient } from '../../api/client';
import { useAppDispatch, useAppSelector } from '../..';
import { mergeChainsSucceeded } from './chainsSlice';

export function useEnsureChainMetadata(chainIds: number[]): void {
  const dispatch = useAppDispatch();
  const chains = useAppSelector((state) => state.chains.chains);

  // Views can reference chains the TVL-ranked top-N fetch never loads, so
  // backfill their metadata by id.
  useEffect(() => {
    const missing = chainIds.filter(
      (chainId) => !chains.some((chain) => chain.chainId === chainId)
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map((chainId) =>
        apiClient
          .request('listChains', { query: { q: String(chainId), limit: 50 } })
          .then((response) =>
            'data' in response
              ? response.data.chains.filter(
                  (chain) => chain.chainId === chainId
                )
              : []
          )
          .catch(() => [])
      )
    ).then((results) => {
      const found = results.flat();
      if (!cancelled && found.length) dispatch(mergeChainsSucceeded(found));
    });
    return () => {
      cancelled = true;
    };
  }, [chainIds, chains, dispatch]);
}
