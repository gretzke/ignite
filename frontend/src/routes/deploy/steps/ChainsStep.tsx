import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import type { RpcEndpoint } from '@ignite/api';
import Select from '../../../components/Select';
import ChainRpcManager from '../../../components/chains/ChainRpcManager';
import ChainIcon from '../../settings/tabs/chains/ChainIcon';
import { useAppDispatch, useAppSelector } from '../../../store';
import { chainsApi } from '../../../store/features/chains/chainsSlice';
import {
  selectRpc,
  toggleChain,
} from '../../../store/features/deployments/deployDraftSlice';

export default function ChainsStep() {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      chainsApi
        .fetchChains(search || undefined, 500)
        .forEach((action) => dispatch(action));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [dispatch, search]);

  useEffect(() => {
    draft.chains.forEach((chainId) =>
      dispatch(chainsApi.fetchRpcs(chainId, true))
    );
  }, [dispatch, draft.chains]);

  const selectedSet = useMemo(() => new Set(draft.chains), [draft.chains]);
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
        {chains.chains.map((chain) => {
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
                  <Select
                    options={endpoints.map((endpoint) => ({
                      value: endpoint.id,
                      label: `${endpoint.label ?? endpoint.id} · ${endpoint.source}`,
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
                          label: endpoint?.label ?? endpointId,
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
