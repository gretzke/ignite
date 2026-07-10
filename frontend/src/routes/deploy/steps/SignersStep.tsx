import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Wallet } from 'lucide-react';
import type { SignerRef } from '@ignite/api';
import Select from '../../../components/Select';
import { useAppDispatch, useAppSelector } from '../../../store';
import { signersApi } from '../../../store/features/signers/signersSlice';
import { runtimeHost } from '../../../runtime/RuntimeHost';
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

  // The runtime host loads plugin bundles asynchronously: read its plugin
  // ids reactively or a fresh page load into the wizard filters the browser
  // wallet out forever (the list was empty at first render).
  const [runtimePluginIds, setRuntimePluginIds] = useState(
    runtimeHost.getLoadedPluginIds()
  );
  useEffect(() => {
    let cancelled = false;
    void runtimeHost.load().then((pluginIds) => {
      if (!cancelled) setRuntimePluginIds(pluginIds);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    signersApi.listAccounts(true).forEach((action) => dispatch(action));
  }, [dispatch]);

  // One connect button per installed wallet extension: connecting without an
  // rdns prompts EVERY wallet (MetaMask and Flask both pop up).
  const [walletsByPlugin, setWalletsByPlugin] = useState<
    Record<string, Array<{ rdns: string; name: string }>>
  >({});
  useEffect(() => {
    let cancelled = false;
    for (const pluginId of runtimePluginIds) {
      void runtimeHost.invokeLocal(pluginId, 'listWallets').then((result) => {
        if (cancelled || !result.success) return;
        const wallets = (
          result.data as { wallets?: Array<{ rdns: string; name: string }> }
        )?.wallets;
        if (Array.isArray(wallets))
          setWalletsByPlugin((current) => ({
            ...current,
            [pluginId]: wallets,
          }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [runtimePluginIds]);

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
      {signers.providers
        // A browser wallet with a registered host reports 'ok' with zero
        // accounts until the user authorizes the site — it must still offer
        // Connect here, or the wallet is simply invisible in the wizard.
        .filter(
          (provider) =>
            provider.accounts.length === 0 &&
            runtimePluginIds.includes(provider.pluginId) &&
            (provider.state === 'needs-browser' || provider.state === 'ok')
        )
        .map((provider) => {
          const wallets = walletsByPlugin[provider.pluginId] ?? [];
          const connecting = signers.connectingPluginId === provider.pluginId;
          return (
            <div
              key={provider.pluginId}
              className="card-milky p-3 flex items-center gap-3 flex-wrap"
            >
              <span className="text-sm">
                {provider.state === 'needs-browser'
                  ? `${provider.name} needs a browser connection.`
                  : `${provider.name} is available — connect it to list accounts.`}
              </span>
              <div className="flex items-center gap-2 ml-auto">
                {wallets.length > 1 ? (
                  wallets.map((wallet) => (
                    <button
                      key={wallet.rdns}
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={connecting}
                      onClick={() =>
                        dispatch(
                          signersApi.connectWallet(
                            provider.pluginId,
                            wallet.rdns
                          )
                        )
                      }
                    >
                      {connecting ? 'Connecting…' : `Connect ${wallet.name}`}
                    </button>
                  ))
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={connecting}
                    onClick={() =>
                      dispatch(signersApi.connectWallet(provider.pluginId))
                    }
                  >
                    {connecting ? 'Connecting…' : 'Connect wallet'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      {signers.loading && refs.length === 0 && (
        <div className="card-milky p-4 flex items-center gap-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" /> Loading signer
          accounts…
        </div>
      )}
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
    </section>
  );
}
