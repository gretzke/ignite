import { useEffect } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import type { SignerRef } from '@ignite/api';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import { signersApi } from '../../../store/features/signers/signersSlice';
import {
  setChainSigner,
  setGlobalSigner,
} from '../../../store/features/deployments/deployDraftSlice';

function refKey(ref: SignerRef | undefined): string | undefined {
  return ref ? `${ref.pluginId}:${ref.accountId}` : undefined;
}

export default function SignersStep() {
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state.deployDraft);
  const signers = useAppSelector((state) => state.signers);
  const chains = useAppSelector((state) => state.chains.chains);

  useEffect(() => {
    signersApi.listAccounts(true).forEach((action) => dispatch(action));
  }, [dispatch]);

  const refs = signers.providers.flatMap((provider) =>
    provider.accounts.map((account) => ({
      value: `${provider.pluginId}:${account.id}`,
      label: `${account.label ?? account.address} · ${provider.name}`,
      ref: {
        pluginId: provider.pluginId,
        accountId: account.id,
        address: account.address,
      } satisfies SignerRef,
    }))
  );
  const options = [{ value: '__none__', label: 'No default' }, ...refs];
  const resolve = (value: string) =>
    refs.find((item) => item.value === value)?.ref;

  return (
    <section className="grid gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Signers</h2>
          <p className="text-sm text-muted">
            Choose a global account, then override only the chains that need
            one.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() =>
            signersApi.listAccounts(true).forEach((action) => dispatch(action))
          }
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div className="card-milky p-4 grid gap-2">
        <span className="eyebrow">Global default</span>
        <Select
          options={options}
          value={refKey(draft.signers.global) ?? '__none__'}
          onValueChange={(value) => dispatch(setGlobalSigner(resolve(value)))}
        />
      </div>
      <div className="glass-list">
        {draft.chains.map((chainId) => {
          const chain = chains.find((item) => item.chainId === chainId);
          const override = draft.signers.perChain?.[String(chainId)];
          const resolved = override ?? draft.signers.global;
          return (
            <div key={chainId} className="list-row grid gap-2">
              <div className="flex items-center gap-2">
                <Wallet size={15} />
                <span className="font-medium">{chain?.name ?? chainId}</span>
                <span
                  className={`chip ml-auto ${resolved ? 'chip-ok' : 'chip-err'}`}
                >
                  <span className="chip-dot" />
                  {resolved ? 'resolved' : 'unresolved'}
                </span>
              </div>
              <Select
                options={options}
                value={refKey(override) ?? '__none__'}
                placeholder="Use global default"
                onValueChange={(value) =>
                  dispatch(setChainSigner({ chainId, signer: resolve(value) }))
                }
              />
            </div>
          );
        })}
      </div>
      {signers.providers
        .filter((provider) => provider.state === 'needs-browser')
        .map((provider) => (
          <div
            key={provider.pluginId}
            className="card-milky p-3 flex items-center gap-3"
          >
            <span className="text-sm">
              {provider.name} needs a browser connection.
            </span>
            <button
              type="button"
              className="btn btn-sm btn-primary ml-auto"
              onClick={() =>
                dispatch(signersApi.connectWallet(provider.pluginId))
              }
            >
              Connect wallet
            </button>
          </div>
        ))}
    </section>
  );
}
