import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import type { RpcEndpoint } from '@ignite/api';
import Select from '../../../components/Select';
import ChainRpcManager from '../../../components/chains/ChainRpcManager';
import ChainIcon from '../../settings/tabs/chains/ChainIcon';
import { useAppDispatch, useAppSelector } from '../../../store';
import { chainsApi } from '../../../store/features/chains/chainsSlice';
import { mergeChainsSucceeded } from '../../../store/features/chains/chainsSlice';
import {
  selectRpc,
  toggleChain,
} from '../../../store/features/deployments/deployDraftSlice';
import { apiClient } from '../../../store/api/client';

export default function ChainsStep() {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains);
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<number[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    if (!search.trim()) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void apiClient
        .request('listChains', { query: { q: search.trim(), limit: 500 } })
        .then((response) => {
          if (!('data' in response)) throw new Error(response.message);
          if (cancelled) return;
          dispatch(mergeChainsSucceeded(response.data.chains));
          setSearchResults(response.data.chains.map((chain) => chain.chainId));
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dispatch, search]);

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .request('listChains', { query: { limit: 500 } })
      .then((response) => {
        if (!('data' in response)) throw new Error(response.message);
        if (!cancelled) dispatch(mergeChainsSucceeded(response.data.chains));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dispatch]);

  useEffect(() => {
    draft.chains.forEach((chainId) =>
      dispatch(chainsApi.fetchRpcs(chainId, true))
    );
  }, [dispatch, draft.chains]);

  // Convenience default: bind the preferred (else first) endpoint as soon as
  // a selected chain has endpoints and no explicit choice yet. The draft is
  // the single source of truth — the select never displays anything the
  // draft doesn't hold.
  useEffect(() => {
    for (const chainId of draft.chains) {
      const key = String(chainId);
      if (draft.rpcSelection[key]) continue;
      const candidates: RpcEndpoint[] = [
        ...(chains.rpcByChain[key] ?? []),
        ...(chains.providerRpcByChain[key] ?? []),
      ];
      const pick =
        candidates.find((endpoint) => endpoint.preferred) ?? candidates[0];
      if (pick) {
        dispatch(
          selectRpc({
            chainId,
            endpointId: pick.id,
            label: pick.label ?? pick.url,
          })
        );
      }
    }
  }, [
    dispatch,
    draft.chains,
    draft.rpcSelection,
    chains.rpcByChain,
    chains.providerRpcByChain,
  ]);

  const selectedSet = useMemo(() => new Set(draft.chains), [draft.chains]);
  const visibleChains = useMemo(() => {
    const base =
      searchResults === null
        ? chains.chains
        : chains.chains.filter((chain) =>
            new Set([...draft.chains, ...searchResults]).has(chain.chainId)
          );
    // Selected chains pin to the top: with hundreds of rows, a selected
    // chain missing its RPC endpoint must never hide below the fold — that
    // reads as "Continue is broken" with no visible reason.
    return [...base].sort(
      (a, b) =>
        Number(selectedSet.has(b.chainId)) - Number(selectedSet.has(a.chainId))
    );
  }, [chains.chains, draft.chains, searchResults, selectedSet]);
  return (
    <section className="grid gap-4">
      <div>
        <h2 className="text-lg font-semibold">Chains & RPCs</h2>
        <p className="text-sm text-muted">
          Select every target chain and bind one endpoint to the frozen run.
        </p>
      </div>
      <label className="input-glass flex items-center gap-2">
        <Search size={15} className="text-muted" />
        <input
          className="bg-transparent outline-none flex-1"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search chains, including testnets"
        />
      </label>
      <div className="grid gap-3">
        {visibleChains.map((chain) => {
          const selected = selectedSet.has(chain.chainId);
          const key = String(chain.chainId);
          const endpoints: RpcEndpoint[] = [
            ...(chains.rpcByChain[key] ?? []),
            ...(chains.providerRpcByChain[key] ?? []),
          ];
          return (
            <article key={chain.chainId} className="card-milky p-4">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => dispatch(toggleChain(chain.chainId))}
                  aria-label={`Deploy to ${chain.name}`}
                />
                <ChainIcon chain={chain} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{chain.name}</div>
                  <div className="mono-data text-muted">
                    {chain.chainId} · {chain.nativeCurrency.symbol}
                  </div>
                </div>
              </div>
              {selected && (
                <div className="grid gap-2 mt-3 pl-11">
                  {!draft.rpcSelection[key] && (
                    <p className="text-sm text-warn">
                      {endpoints.length === 0
                        ? 'No endpoints for this chain yet — add one under "Manage endpoints inline".'
                        : 'Select an RPC endpoint to continue.'}
                    </p>
                  )}
                  <Select
                    requireSelection
                    options={endpoints.map((endpoint) => ({
                      value: endpoint.id,
                      // Users pick URLs, not endpoint ids or registry
                      // provenance — show the label only when someone set one.
                      label: endpoint.label
                        ? `${endpoint.label} · ${endpoint.url}`
                        : endpoint.url,
                    }))}
                    value={draft.rpcSelection[key]?.endpointId}
                    placeholder="Select an RPC endpoint"
                    onValueChange={(endpointId) => {
                      const endpoint = endpoints.find(
                        (item) => item.id === endpointId
                      );
                      dispatch(
                        selectRpc({
                          chainId: chain.chainId,
                          endpointId,
                          label: endpoint?.label ?? endpoint?.url ?? endpointId,
                        })
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary-borderless justify-self-start"
                    onClick={() =>
                      setExpanded(
                        expanded === chain.chainId ? null : chain.chainId
                      )
                    }
                  >
                    {expanded === chain.chainId ? (
                      <ChevronUp size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}{' '}
                    Manage endpoints inline
                  </button>
                  {expanded === chain.chainId && (
                    <ChainRpcManager chainId={chain.chainId} />
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
