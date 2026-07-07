// frontend/src/routes/settings/tabs/chains/ChainModal.tsx
// Create/edit dialog for user-defined (custom) chains. Custom chains shadow
// chainlist entries with the same chainId and are stored per-user only.
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ChainInfo } from '@ignite/api';
import { useAppDispatch } from '../../../../store';
import { chainsApi } from '../../../../store/features/chains/chainsSlice';

interface ChainModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chain?: ChainInfo; // present = edit mode (chainId locked)
}

export default function ChainModal({
  open,
  onOpenChange,
  chain,
}: ChainModalProps) {
  const dispatch = useAppDispatch();
  const [chainId, setChainId] = useState('');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('ETH');
  const [decimals, setDecimals] = useState('18');
  const [explorerUrl, setExplorerUrl] = useState('');

  useEffect(() => {
    if (!open) return;
    setChainId(chain ? String(chain.chainId) : '');
    setName(chain?.name ?? '');
    setSymbol(chain?.nativeCurrency.symbol ?? 'ETH');
    setDecimals(String(chain?.nativeCurrency.decimals ?? 18));
    setExplorerUrl(chain?.explorers?.[0]?.url ?? '');
  }, [open, chain]);

  const chainIdNum = Number(chainId);
  const decimalsNum = Number(decimals);
  const explorerValid =
    explorerUrl.trim() === '' || /^https?:\/\/.+/.test(explorerUrl.trim());
  const canSubmit =
    Number.isInteger(chainIdNum) &&
    chainIdNum > 0 &&
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    Number.isInteger(decimalsNum) &&
    decimalsNum >= 0 &&
    explorerValid;

  const handleSave = () => {
    const trimmedExplorer = explorerUrl.trim();
    dispatch(
      chainsApi.upsertChain({
        chainId: chainIdNum,
        name: name.trim(),
        nativeCurrency: {
          name: symbol.trim(),
          symbol: symbol.trim(),
          decimals: decimalsNum,
        },
        explorers: trimmedExplorer
          ? [{ name: 'explorer', url: trimmedExplorer }]
          : undefined,
      })
    );
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" style={{ background: 'transparent' }} />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 480, width: '90vw', padding: 16 }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            {chain ? 'Edit custom chain' : 'Add custom chain'}
          </Dialog.Title>
          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="text-xs text-muted">Chain ID</span>
              <input
                className="input-glass mono-data"
                value={chainId}
                onChange={(e) => setChainId(e.target.value.replace(/\D/g, ''))}
                placeholder="e.g. 999999"
                disabled={!!chain}
                inputMode="numeric"
              />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-muted">Name</span>
              <input
                className="input-glass"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Stealth Testnet"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className="text-xs text-muted">Currency symbol</span>
                <input
                  className="input-glass"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  placeholder="ETH"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs text-muted">Decimals</span>
                <input
                  className="input-glass mono-data"
                  value={decimals}
                  onChange={(e) => setDecimals(e.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-xs text-muted">Explorer URL (optional)</span>
              <input
                className="input-glass mono-data"
                value={explorerUrl}
                onChange={(e) => setExplorerUrl(e.target.value)}
                placeholder="https://explorer.example.com"
              />
              {!explorerValid && (
                <span className="text-xs text-err">
                  Must be an http(s) URL
                </span>
              )}
            </label>
          </div>
          <div className="flex items-center justify-end gap-2 mt-4">
            <Dialog.Close asChild>
              <button className="btn btn-secondary">Cancel</button>
            </Dialog.Close>
            <button
              className="btn btn-primary"
              disabled={!canSubmit}
              onClick={handleSave}
            >
              {chain ? 'Save changes' : 'Add chain'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
