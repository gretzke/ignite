import { useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Send } from 'lucide-react';
import type { RpcEndpoint, SendSignerTxRequest } from '@ignite/api';
import Select from '../../components/Select';
import Tooltip from '../../components/Tooltip';
import { useAppDispatch, useAppSelector } from '../../store';
import { chainsApi } from '../../store/features/chains/chainsSlice';
import { signersApi } from '../../store/features/signers/signersSlice';
import { selectJob } from '../../store/features/jobs/jobsSlice';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const VALUE_RE = /^\d+$/;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

type SelectedAccount = { pluginId: string; accountId: string } | null;

function rpcStatusLabel(endpoint: RpcEndpoint): string {
  const verification = endpoint.lastVerification;
  if (!verification) return 'unchecked';
  if (verification.ok) {
    return verification.latencyMs !== undefined
      ? `${verification.latencyMs} ms`
      : 'healthy';
  }
  return verification.chainIdMatch === false ? 'wrong chain' : 'unhealthy';
}

function rpcStatusChip(endpoint: RpcEndpoint) {
  const verification = endpoint.lastVerification;
  if (!verification) return <span className="chip">unchecked</span>;
  if (verification.ok) {
    return (
      <span className="chip chip-ok">
        <span className="chip-dot" />
        {verification.latencyMs !== undefined
          ? `${verification.latencyMs} ms`
          : 'healthy'}
      </span>
    );
  }
  return (
    <Tooltip label={verification.error ?? 'Verification failed'}>
      <span className="chip chip-err">
        <span className="chip-dot" />
        {verification.chainIdMatch === false ? 'wrong chain' : 'unhealthy'}
      </span>
    </Tooltip>
  );
}

function jobStateChip(state: string) {
  const cls =
    state === 'succeeded'
      ? 'chip chip-ok'
      : state === 'failed' || state === 'cancelled'
        ? 'chip chip-err'
        : 'chip chip-warn';
  return (
    <span className={cls}>
      <span className="chip-dot" />
      {state}
    </span>
  );
}

function providerHint(state: string): string {
  if (state === 'needs-config') return 'Configure in Settings -> Plugins';
  if (state === 'needs-browser') return 'Requires an open browser wallet (D2b)';
  if (state === 'error') return 'Provider returned an error';
  return 'No accounts available';
}

function resultField(result: unknown, key: string): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const value = (result as Record<string, unknown>)[key];
  return value === undefined ? undefined : String(value);
}

export default function DevSendPage() {
  const dispatch = useAppDispatch();
  const chainsState = useAppSelector((state) => state.chains);
  const signersState = useAppSelector((state) => state.signers);
  const activeJob = useAppSelector((state) =>
    signersState.lastSendJobId
      ? selectJob(state, signersState.lastSendJobId)
      : undefined
  );
  const [chainId, setChainId] = useState('');
  const [rpcEndpointId, setRpcEndpointId] = useState('');
  const [account, setAccount] = useState<SelectedAccount>(null);
  const [to, setTo] = useState('');
  const [value, setValue] = useState('0');
  const [data, setData] = useState('');

  useEffect(() => {
    chainsApi.fetchChains().forEach((action) => dispatch(action));
    signersApi.listAccounts().forEach((action) => dispatch(action));
  }, [dispatch]);

  useEffect(() => {
    if (!chainId && chainsState.chains.length > 0) {
      setChainId(String(chainsState.chains[0].chainId));
    }
  }, [chainId, chainsState.chains]);

  useEffect(() => {
    if (!chainId) return;
    dispatch(chainsApi.fetchRpcs(Number(chainId), true));
    setRpcEndpointId('');
  }, [chainId, dispatch]);

  const selectedChain = chainsState.chains.find(
    (chain) => String(chain.chainId) === chainId
  );
  const chainOptions = chainsState.chains.map((chain) => ({
    value: String(chain.chainId),
    label: `${chain.name} (${chain.chainId})`,
  }));

  const rpcEndpoints = useMemo(() => {
    if (!chainId) return [];
    const key = String(chainId);
    return [
      ...(chainsState.rpcByChain[key] ?? []),
      ...(chainsState.providerRpcByChain[key] ?? []),
    ];
  }, [chainId, chainsState.providerRpcByChain, chainsState.rpcByChain]);

  useEffect(() => {
    if (rpcEndpointId && rpcEndpoints.some((endpoint) => endpoint.id === rpcEndpointId)) {
      return;
    }
    const preferred = rpcEndpoints.find((endpoint) => endpoint.preferred);
    setRpcEndpointId(preferred?.id ?? rpcEndpoints[0]?.id ?? '');
  }, [rpcEndpointId, rpcEndpoints]);

  const rpcOptions = rpcEndpoints.map((endpoint) => {
    const labelParts = [
      endpoint.label ?? endpoint.url,
      endpoint.source === 'plugin' && endpoint.pluginId
        ? endpoint.pluginId
        : endpoint.source,
      rpcStatusLabel(endpoint),
    ];
    return { value: endpoint.id, label: labelParts.filter(Boolean).join(' · ') };
  });
  const selectedRpc = rpcEndpoints.find((endpoint) => endpoint.id === rpcEndpointId);

  const accountStillExists =
    account &&
    signersState.providers.some(
      (provider) =>
        provider.pluginId === account.pluginId &&
        provider.accounts.some((entry) => entry.id === account.accountId)
    );

  useEffect(() => {
    if (accountStillExists) return;
    const first = signersState.providers
      .flatMap((provider) =>
        provider.accounts.map((entry) => ({
          pluginId: provider.pluginId,
          accountId: entry.id,
        }))
      )
      .at(0);
    setAccount(first ?? null);
  }, [accountStillExists, signersState.providers]);

  const toValid = ADDRESS_RE.test(to.trim());
  const valueValid = VALUE_RE.test(value.trim());
  const dataValid = data.trim() === '' || DATA_RE.test(data.trim());
  const canSend =
    Boolean(selectedChain && selectedRpc && account) &&
    toValid &&
    valueValid &&
    dataValid &&
    !signersState.sending;

  const handleSend = () => {
    if (!selectedChain || !selectedRpc || !account || !canSend) return;
    const body: SendSignerTxRequest = {
      pluginId: account.pluginId,
      accountId: account.accountId,
      chainId: selectedChain.chainId,
      rpcEndpointId: selectedRpc.id,
      to: to.trim(),
      value: value.trim(),
      ...(data.trim() ? { data: data.trim() } : {}),
    };
    signersApi.sendTx(body).forEach((action) => dispatch(action));
  };

  const resultTxHash = resultField(activeJob?.result, 'txHash');
  const resultStatus = resultField(activeJob?.result, 'status');
  const resultBlockNumber = resultField(activeJob?.result, 'blockNumber');

  return (
    <div className="text-[var(--text)]">
      <div className="flex items-center justify-between mb-4">
        <h2 className="page-title">Dev Send</h2>
        <Tooltip label="Refresh signer accounts">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() =>
              signersApi.listAccounts(true).forEach((action) => dispatch(action))
            }
          >
            <RefreshCw size={14} />
            Refresh accounts
          </button>
        </Tooltip>
      </div>

      <div className="card-milky p-4 grid gap-4" style={{ maxWidth: 760 }}>
        <section className="grid gap-3">
          <div className="grid gap-1">
            <span className="eyebrow">Chain</span>
            <Select
              options={chainOptions}
              value={chainId || undefined}
              placeholder={chainsState.loading ? 'Loading chains...' : 'Select chain'}
              onValueChange={setChainId}
            />
          </div>

          <div className="grid gap-1">
            <div className="eyebrow flex items-center justify-between">
              <span>RPC endpoint</span>
              {chainId && (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary-borderless"
                  onClick={() => dispatch(chainsApi.fetchRpcs(Number(chainId), true))}
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
              )}
            </div>
            <Select
              options={rpcOptions}
              value={rpcEndpointId || undefined}
              placeholder="Select RPC endpoint"
              disabled={!chainId || rpcOptions.length === 0}
              onValueChange={setRpcEndpointId}
            />
            {selectedRpc && (
              <div className="flex items-center gap-2 text-xs text-muted min-w-0">
                <span className="mono-data truncate">{selectedRpc.url}</span>
                {selectedRpc.source === 'plugin' && selectedRpc.pluginId && (
                  <span className="pill">{selectedRpc.pluginId}</span>
                )}
                {rpcStatusChip(selectedRpc)}
              </div>
            )}
            {chainId && rpcOptions.length === 0 && (
              <span className="text-xs text-muted">
                No RPC endpoints configured for this chain.
              </span>
            )}
          </div>
        </section>

        <section className="grid gap-2">
          <div className="eyebrow">Account</div>
          <div className="glass-list">
            {signersState.loading && (
              <div className="list-row text-muted">Loading signer accounts...</div>
            )}
            {!signersState.loading && signersState.providers.length === 0 && (
              <div className="list-row text-muted">No signer providers found.</div>
            )}
            {signersState.providers.map((provider) => (
              <div key={provider.pluginId} className="list-row">
                <div className="grid gap-2 w-full min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{provider.name}</div>
                      <div className="text-xs text-muted mono-data truncate">
                        {provider.pluginId}
                      </div>
                    </div>
                    <span
                      className={
                        provider.state === 'ok'
                          ? 'chip chip-ok'
                          : provider.state === 'error'
                            ? 'chip chip-err'
                            : 'chip chip-warn'
                      }
                    >
                      <span className="chip-dot" />
                      {provider.state}
                    </span>
                  </div>

                  {provider.accounts.length === 0 ? (
                    <div className="text-sm text-muted">
                      {providerHint(provider.state)}
                    </div>
                  ) : (
                    <div className="grid gap-1">
                      {provider.accounts.map((entry) => {
                        const selected =
                          account?.pluginId === provider.pluginId &&
                          account.accountId === entry.id;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`glass-surface nav-item flex items-center justify-between text-left ${
                              selected ? 'active' : ''
                            }`}
                            style={{ padding: '0.65rem 0.8rem' }}
                            onClick={() =>
                              setAccount({
                                pluginId: provider.pluginId,
                                accountId: entry.id,
                              })
                            }
                          >
                            <span className="min-w-0">
                              <span className="block truncate">
                                {entry.label ?? entry.id}
                              </span>
                              <span className="block text-xs text-muted mono-data truncate">
                                {entry.address}
                              </span>
                            </span>
                            <span className="pill shrink-0">{entry.capability}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {signersState.error && (
            <span className="text-xs text-err">{signersState.error}</span>
          )}
        </section>

        <section className="grid gap-3">
          <div className="grid gap-1">
            <label className="eyebrow" htmlFor="dev-send-to">
              To
            </label>
            <input
              id="dev-send-to"
              className="input-glass mono-data"
              placeholder="0x..."
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            {to && !toValid && (
              <span className="text-xs text-err">Expected a 20-byte hex address.</span>
            )}
          </div>

          <div className="grid gap-1">
            <label className="eyebrow" htmlFor="dev-send-value">
              Value (wei)
            </label>
            <input
              id="dev-send-value"
              className="input-glass mono-data"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            {value && !valueValid && (
              <span className="text-xs text-err">Expected a decimal wei string.</span>
            )}
          </div>

          <div className="grid gap-1">
            <label className="eyebrow" htmlFor="dev-send-data">
              Data
            </label>
            <input
              id="dev-send-data"
              className="input-glass mono-data"
              placeholder="0x"
              value={data}
              onChange={(event) => setData(event.target.value)}
            />
            {data && !dataValid && (
              <span className="text-xs text-err">
                Expected 0x-prefixed even-length hex data.
              </span>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            {signersState.sendError && (
              <span className="text-sm text-err mr-auto">
                {signersState.sendError}
              </span>
            )}
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSend}
              onClick={handleSend}
            >
              {signersState.sending ? (
                <Activity size={16} />
              ) : (
                <Send size={16} />
              )}
              Send
            </button>
          </div>
        </section>

        {activeJob && (
          <section className="grid gap-2">
            <div className="eyebrow flex items-center justify-between">
              <span>Job</span>
              {jobStateChip(activeJob.state)}
            </div>
            <div className="glass-list">
              {activeJob.logTail.length === 0 ? (
                <div className="list-row text-muted">Waiting for job logs...</div>
              ) : (
                activeJob.logTail.map((line, index) => (
                  <div key={`${index}-${line}`} className="list-row">
                    <span className="mono-data text-sm break-words">{line}</span>
                  </div>
                ))
              )}
            </div>
            {activeJob.state === 'succeeded' && (
              <div className="card-milky p-3 grid gap-1">
                {resultTxHash && (
                  <div className="text-sm">
                    <span className="text-muted">txHash </span>
                    <span className="mono-data break-words">{resultTxHash}</span>
                  </div>
                )}
                {resultStatus && (
                  <div className="text-sm">
                    <span className="text-muted">status </span>
                    <span>{resultStatus}</span>
                  </div>
                )}
                {resultBlockNumber && (
                  <div className="text-sm">
                    <span className="text-muted">blockNumber </span>
                    <span className="mono-data">{resultBlockNumber}</span>
                  </div>
                )}
              </div>
            )}
            {activeJob.state === 'failed' && activeJob.error && (
              <div className="card-milky p-3 text-sm text-err">
                {activeJob.error.message}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
