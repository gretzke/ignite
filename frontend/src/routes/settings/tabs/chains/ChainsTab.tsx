// frontend/src/routes/settings/tabs/chains/ChainsTab.tsx
// Chains registry: user-defined chains (editable) + chainlist dataset
// (read-only, searchable). All data is per-user; nothing here is shared.
import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Pencil, Trash2, PlugZap } from 'lucide-react';
import type { ChainInfo } from '@ignite/api';
import { useAppDispatch, useAppSelector } from '../../../../store';
import { chainsApi } from '../../../../store/features/chains/chainsSlice';
import Tooltip from '../../../../components/Tooltip';
import ConfirmDialog from '../../../../components/ConfirmDialog';
import ChainIcon from './ChainIcon';
import ChainModal from './ChainModal';
import ChainRpcModal from './ChainRpcModal';

export default function ChainsTab() {
  const dispatch = useAppDispatch();
  const { chains, total, fetchedAt, loading } = useAppSelector(
    (state) => state.chains
  );
  const [query, setQuery] = useState('');
  const [chainModal, setChainModal] = useState<{
    open: boolean;
    chain?: ChainInfo;
  }>({ open: false });
  const [rpcChain, setRpcChain] = useState<ChainInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChainInfo | null>(null);

  // Debounced server-side search; the initial empty-query run on first
  // paint also covers the mount fetch (250ms delay is acceptable).
  useEffect(() => {
    const t = setTimeout(() => {
      chainsApi.fetchChains(query || undefined).forEach((a) => dispatch(a));
    }, 250);
    return () => clearTimeout(t);
  }, [query, dispatch]);

  const custom = useMemo(
    () => chains.filter((c) => c.source === 'custom'),
    [chains]
  );
  const known = useMemo(
    () => chains.filter((c) => c.source === 'chainlist'),
    [chains]
  );

  const row = (chain: ChainInfo) => (
    <div
      key={chain.chainId}
      className="glass-surface nav-item flex items-center justify-between"
      // .nav-item has no padding outside the sidebar; match the ProfilesTab
      // row convention so the tile sits inside the card with breathing room.
      style={{ padding: '0.9rem 1.1rem' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <ChainIcon chain={chain} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate">{chain.name}</span>
            {chain.source === 'custom' && (
              <span className="pill pill-primary">custom</span>
            )}
          </div>
          <div className="text-xs text-muted mono-data">
            chainId {chain.chainId}
            {chain.shortName ? ` · ${chain.shortName}` : ''}
            {' · '}
            {chain.nativeCurrency.symbol}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Tooltip label="RPC endpoints">
          <button
            className="btn btn-sm btn-secondary-borderless"
            onClick={() => setRpcChain(chain)}
            aria-label={`RPC endpoints for ${chain.name}`}
          >
            <PlugZap size={16} />
          </button>
        </Tooltip>
        {chain.source === 'custom' && (
          <>
            <Tooltip label="Edit chain">
              <button
                className="btn btn-sm btn-secondary-borderless"
                onClick={() => setChainModal({ open: true, chain })}
                aria-label={`Edit ${chain.name}`}
              >
                <Pencil size={16} />
              </button>
            </Tooltip>
            <Tooltip label="Delete chain">
              <button
                className="btn btn-sm btn-secondary-borderless"
                onClick={() => setDeleteTarget(chain)}
                aria-label={`Delete ${chain.name}`}
              >
                <Trash2 size={16} />
              </button>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <input
          className="input-glass"
          style={{ maxWidth: 320 }}
          placeholder="Search chains by name or id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Tooltip
            label={
              fetchedAt
                ? `Chainlist cached ${new Date(fetchedAt).toLocaleString()}`
                : 'Chainlist never fetched'
            }
          >
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => dispatch(chainsApi.refreshChains())}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </Tooltip>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => setChainModal({ open: true })}
          >
            <Plus size={14} />
            Add custom chain
          </button>
        </div>
      </div>

      {custom.length > 0 && (
        <section className="grid gap-2">
          <div className="eyebrow">Custom chains</div>
          {custom.map(row)}
        </section>
      )}

      <section className="grid gap-2">
        <div className="eyebrow">
          Known chains{total > chains.length ? ` (${total} matches)` : ''}
        </div>
        {loading && chains.length === 0 ? (
          <div className="card-milky p-4 text-muted">Loading chains…</div>
        ) : known.length === 0 ? (
          <div className="card-milky p-4 text-muted">
            No chains match “{query}”. Add it as a custom chain if it isn’t on
            chainlist yet.
          </div>
        ) : (
          known.map(row)
        )}
      </section>

      <ChainModal
        open={chainModal.open}
        chain={chainModal.chain}
        onOpenChange={(open) =>
          setChainModal((s) => ({ open, chain: open ? s.chain : undefined }))
        }
      />
      {rpcChain && (
        <ChainRpcModal
          chain={rpcChain}
          open={rpcChain !== null}
          onOpenChange={(open) => !open && setRpcChain(null)}
        />
      )}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete custom chain?"
        description={
          deleteTarget
            ? `Remove "${deleteTarget.name}" (chainId ${deleteTarget.chainId}) and fall back to the chainlist entry if one exists. Stored RPC endpoints for this chain are kept.`
            : ''
        }
        confirmText="Delete"
        onConfirm={() => {
          if (deleteTarget) dispatch(chainsApi.deleteChain(deleteTarget.chainId));
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
