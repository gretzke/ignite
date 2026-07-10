import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Star,
  Trash2,
} from 'lucide-react';
import type { RpcEndpoint, RpcVerificationResult } from '@ignite/api';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  chainsApi,
  providerChecksReset,
  rpcCheckReset,
} from '../../store/features/chains/chainsSlice';
import {
  openConfigModal,
  pluginsApi,
} from '../../store/features/plugins/pluginsSlice';
import Tooltip from '../Tooltip';

// Cap on concurrent auto-probes of plugin-provided endpoints so opening a
// chain with many configured providers doesn't fire a burst of requests.
const MAX_CONCURRENT_PROBES = 3;

// Provider-side entitlement errors (401/403/"unauthorized"/"forbidden") mean
// the endpoint itself is reachable but the caller's key isn't enabled for
// this chain — distinct from a generically unhealthy endpoint.
const AUTH_ERROR_RE = /\b(401|403|unauthorized|forbidden)\b/i;

// Stable fallback so effects keyed on the endpoints array don't re-fire on
// every render while the first fetch is in flight.
const EMPTY_ENDPOINTS: RpcEndpoint[] = [];

export interface ChainRpcManagerProps {
  chainId: number;
  onEndpointsChanged?: () => void;
}

function HealthChip({ endpoint }: { endpoint: RpcEndpoint }) {
  const v = endpoint.lastVerification;
  if (!v) {
    return <span className="chip">unchecked</span>;
  }
  if (v.ok) {
    return (
      <span className="chip chip-ok">
        <span className="chip-dot" />
        {v.latencyMs !== undefined ? `${v.latencyMs} ms` : 'healthy'}
        {v.blockAgeSeconds !== undefined && v.blockAgeSeconds > 60
          ? ` · block ${v.blockAgeSeconds}s old`
          : ''}
      </span>
    );
  }
  return (
    <Tooltip label={v.error ?? 'Verification failed'}>
      <span className="chip chip-err">
        <span className="chip-dot" />
        {v.chainIdMatch === false ? 'wrong chain' : 'unhealthy'}
      </span>
    </Tooltip>
  );
}

function ProviderHealthChip({
  checkState,
}: {
  checkState: RpcVerificationResult | 'checking' | undefined;
}) {
  if (checkState === 'checking') {
    return <Loader2 size={14} className="animate-spin" />;
  }
  if (!checkState) {
    return null;
  }
  if (checkState.ok) {
    return (
      <span className="chip chip-ok">
        <span className="chip-dot" />
        {checkState.latencyMs !== undefined
          ? `${checkState.latencyMs} ms`
          : 'healthy'}
      </span>
    );
  }
  // Distinguish "provider rejected the key/plan for this chain" from a
  // generically unreachable/broken endpoint — this is the empirical answer
  // to "which chains does my Infura/Alchemy key actually have enabled".
  const authGated = checkState.error
    ? AUTH_ERROR_RE.test(checkState.error)
    : false;
  return (
    <Tooltip label={checkState.error ?? 'Verification failed'}>
      <span className={`chip ${authGated ? 'chip-warn' : 'chip-err'}`}>
        <span className="chip-dot" />
        {authGated ? 'key not enabled' : 'unhealthy'}
      </span>
    </Tooltip>
  );
}

export default function ChainRpcManager({
  chainId,
  onEndpointsChanged,
}: ChainRpcManagerProps) {
  const dispatch = useAppDispatch();
  const chain = useAppSelector((state) =>
    state.chains.chains.find((candidate) => candidate.chainId === chainId)
  );
  // No `?? []` default here: `undefined` means "never fetched for this chain"
  // and drives the loading row, while `[]` is a genuine empty result.
  const storedEndpoints = useAppSelector(
    (state) => state.chains.rpcByChain[String(chainId)]
  );
  const rpcsLoading = storedEndpoints === undefined;
  const endpoints = storedEndpoints ?? EMPTY_ENDPOINTS;
  const providerEndpoints = useAppSelector(
    (state) => state.chains.providerRpcByChain[String(chainId)] ?? []
  );
  const providerChecks = useAppSelector((state) => state.chains.providerChecks);
  const rpcCheck = useAppSelector((state) => state.chains.rpcCheck);
  const providerStatuses = useAppSelector(
    (state) => state.chains.providerStatusesByChain[String(chainId)] ?? []
  );
  const [newUrl, setNewUrl] = useState('');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  // Snapshot of the checkedAt seen when a verify was kicked off, so the
  // reactive clear below only fires once a *new* result lands rather than
  // instantly clearing on a pre-existing lastVerification.
  const verifyingRef = useRef<{ id: string; prevCheckedAt?: string } | null>(
    null
  );
  const verifyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEndpointsChangedRef = useRef(onEndpointsChanged);

  useEffect(() => {
    onEndpointsChangedRef.current = onEndpointsChanged;
  }, [onEndpointsChanged]);

  useEffect(() => {
    // refresh: true bypasses the provider cache on every mount — the user may
    // have edited something Ignite can't see on its own (e.g. hand-editing
    // ~/.chainz.json for a config-file-based provider), so a stale "needs
    // configuration" hint or endpoint list would be actively misleading.
    dispatch(chainsApi.fetchRpcs(chainId, true));
  }, [chainId, dispatch]);

  // Plugin metadata (configFields etc.) that PluginConfigModal needs once the
  // user clicks Configure from a needs-config hint row — refreshed on mount
  // so a just-installed plugin is present in the store.
  useEffect(() => {
    pluginsApi.refresh().forEach((action) => dispatch(action));
  }, [dispatch]);

  useEffect(() => {
    if (storedEndpoints !== undefined) {
      onEndpointsChangedRef.current?.();
    }
  }, [storedEndpoints]);

  // Clear the spinner as soon as a fresh verification result lands for the
  // endpoint currently being verified, instead of relying solely on the
  // fallback timeout below.
  useEffect(() => {
    const verifying = verifyingRef.current;
    if (!verifying) return;
    const endpoint = endpoints.find(
      (candidate) => candidate.id === verifying.id
    );
    const checkedAt = endpoint?.lastVerification?.checkedAt;
    if (checkedAt && checkedAt !== verifying.prevCheckedAt) {
      verifyingRef.current = null;
      setVerifyingId(null);
      if (verifyTimeoutRef.current) {
        clearTimeout(verifyTimeoutRef.current);
        verifyTimeoutRef.current = null;
      }
    }
  }, [endpoints]);

  // Fallback timeout cleanup on unmount.
  useEffect(
    () => () => {
      if (verifyTimeoutRef.current) clearTimeout(verifyTimeoutRef.current);
    },
    []
  );

  // Debounced pre-save check of the manual URL.
  useEffect(() => {
    const url = newUrl.trim();
    if (!url || !/^https?:\/\/.+/.test(url)) {
      dispatch(rpcCheckReset());
      return;
    }
    const timeout = setTimeout(() => {
      chainsApi.checkRpc(url, chainId).forEach((action) => dispatch(action));
    }, 400);
    return () => clearTimeout(timeout);
  }, [newUrl, chainId, dispatch]);

  // Reset shared check state when this manager leaves its host surface.
  useEffect(
    () => () => {
      dispatch(rpcCheckReset());
      dispatch(providerChecksReset());
    },
    [dispatch]
  );

  const storedUrls = new Set(endpoints.map((endpoint) => endpoint.url));
  const suggestions = (chain?.rpc ?? []).filter((url) => !storedUrls.has(url));
  // A provider URL the user manually saved is already in Configured — don't
  // show it twice under Plugin endpoints.
  const availableProviderEndpoints = providerEndpoints.filter(
    (endpoint) => !storedUrls.has(endpoint.url)
  );
  // Providers the backend explicitly reports as unconfigured (getSupportedChains
  // returned chains: null). Providers that are configured but simply have no
  // endpoints for this particular chain render nothing — that's not
  // something the user needs to act on.
  const needsConfigProviders = providerStatuses.filter(
    (status) => status.state === 'needs-config'
  );

  // Auto-probe plugin endpoints that haven't been checked yet, capped at
  // MAX_CONCURRENT_PROBES in flight. `checkProviderRpc` marks the endpoint
  // 'checking' synchronously, so once dispatched it drops out of `pending`
  // on the next render — this can't loop.
  useEffect(() => {
    const inFlight = availableProviderEndpoints.filter(
      (endpoint) => providerChecks[endpoint.id] === 'checking'
    ).length;
    const room = MAX_CONCURRENT_PROBES - inFlight;
    if (room <= 0) return;
    const pending = availableProviderEndpoints.filter(
      (endpoint) => providerChecks[endpoint.id] === undefined
    );
    pending
      .slice(0, room)
      .forEach((endpoint) =>
        chainsApi
          .checkProviderRpc(chainId, endpoint)
          .forEach((action) => dispatch(action))
      );
    // availableProviderEndpoints is a new array each render; the guard above
    // is state-based (not reference-based), so re-running this effect on
    // every render is harmless — it just re-checks and finds nothing to do.
  }, [availableProviderEndpoints, providerChecks, chainId, dispatch]);

  const trimmedUrl = newUrl.trim();
  const checkOk = rpcCheck.url === trimmedUrl && rpcCheck.result?.ok === true;
  const checkMismatch =
    rpcCheck.url === trimmedUrl &&
    rpcCheck.result !== null &&
    rpcCheck.result.chainIdMatch === false;
  const urlShapeValid = /^https?:\/\/.+/.test(trimmedUrl);
  const checkSettled =
    rpcCheck.url === trimmedUrl &&
    !rpcCheck.checking &&
    (rpcCheck.result !== null || rpcCheck.error !== null);
  const checkUnreachable =
    rpcCheck.url === trimmedUrl &&
    rpcCheck.result !== null &&
    rpcCheck.result.ok === false &&
    !checkMismatch;
  const canAdd = urlShapeValid && checkSettled && !checkMismatch;

  const handleAdd = () => {
    dispatch(chainsApi.addRpc(chainId, { url: newUrl.trim() }));
    setNewUrl('');
    dispatch(rpcCheckReset());
  };

  const handleVerify = (endpointId: string) => {
    const endpoint = endpoints.find((candidate) => candidate.id === endpointId);
    verifyingRef.current = {
      id: endpointId,
      prevCheckedAt: endpoint?.lastVerification?.checkedAt,
    };
    setVerifyingId(endpointId);
    dispatch(chainsApi.verifyRpc(chainId, endpointId));
    // The verification result usually lands via rpcVerificationReceived well
    // before this fires; it's a fallback so the spinner never sticks forever.
    if (verifyTimeoutRef.current) clearTimeout(verifyTimeoutRef.current);
    verifyTimeoutRef.current = setTimeout(() => {
      verifyingRef.current = null;
      setVerifyingId(null);
    }, 12_000);
  };

  return (
    <div
      className="flex flex-col"
      style={{ overflowY: 'auto', minHeight: 0, flex: 1 }}
    >
      <div className="grid gap-1 mb-3">
        <div className="eyebrow">Configured</div>
        <div className="glass-list">
          {rpcsLoading && (
            <div className="list-row text-muted flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              Loading endpoints…
            </div>
          )}
          {!rpcsLoading && endpoints.length === 0 && (
            <div className="list-row text-muted">
              No stored endpoints yet. Add one below.
            </div>
          )}
          {endpoints.map((endpoint) => (
            <div key={endpoint.id} className="list-row">
              <div className="flex items-center justify-between gap-2 w-full min-w-0">
                <div className="min-w-0">
                  <div className="mono-data truncate">{endpoint.url}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {endpoint.preferred && (
                      <span className="pill pill-primary">preferred</span>
                    )}
                    <HealthChip endpoint={endpoint} />
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Tooltip label="Verify now">
                    <button
                      className="btn btn-sm btn-secondary-borderless"
                      onClick={() => handleVerify(endpoint.id)}
                      aria-label={`Verify ${endpoint.url}`}
                    >
                      {verifyingId === endpoint.id ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Activity size={16} />
                      )}
                    </button>
                  </Tooltip>
                  {!endpoint.preferred && (
                    <Tooltip label="Set as preferred">
                      <button
                        className="btn btn-sm btn-secondary-borderless"
                        onClick={() =>
                          dispatch(
                            chainsApi.setPreferredRpc(chainId, endpoint.id)
                          )
                        }
                        aria-label={`Prefer ${endpoint.url}`}
                      >
                        <Star size={16} />
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip label="Remove endpoint">
                    <button
                      className="btn btn-sm btn-secondary-borderless"
                      onClick={() =>
                        dispatch(chainsApi.deleteRpc(chainId, endpoint.id))
                      }
                      aria-label={`Remove ${endpoint.url}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-1 mb-3">
        <span className="eyebrow">Add endpoint</span>
        <div className="flex items-center gap-2">
          <input
            className="input-glass mono-data flex-1"
            placeholder="https://rpc.example.com"
            value={newUrl}
            onChange={(event) => setNewUrl(event.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={!canAdd}
            onClick={handleAdd}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
        {rpcCheck.checking && rpcCheck.url === trimmedUrl && (
          <span className="text-xs text-muted flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" /> Checking endpoint…
          </span>
        )}
        {checkOk && (
          <span className="text-xs text-ok">
            Healthy — chainId {rpcCheck.result?.reportedChainId},{' '}
            {rpcCheck.result?.latencyMs} ms
          </span>
        )}
        {checkMismatch && (
          <span className="text-xs text-err">
            {rpcCheck.result?.error ?? 'Chain ID mismatch'}
          </span>
        )}
        {rpcCheck.error && rpcCheck.url === trimmedUrl && (
          <span className="text-xs text-warn">
            Could not check endpoint: {rpcCheck.error}. You can still add it.
          </span>
        )}
        {checkUnreachable && (
          <span className="text-xs text-warn">
            Could not reach endpoint
            {rpcCheck.result?.error ? `: ${rpcCheck.result.error}` : ''}. You
            can still add it.
          </span>
        )}
      </div>

      {!rpcsLoading &&
        (availableProviderEndpoints.length > 0 ||
          needsConfigProviders.length > 0) && (
          <div className="grid gap-1 mb-3">
            <div className="eyebrow flex items-center justify-between">
              <span>Plugin endpoints</span>
              <Tooltip label="Refresh">
                <button
                  className="btn btn-sm btn-secondary-borderless"
                  onClick={() => dispatch(chainsApi.fetchRpcs(chainId, true))}
                  aria-label="Refresh provider endpoints"
                >
                  <RefreshCw size={14} />
                </button>
              </Tooltip>
            </div>
            <div className="glass-list">
              {availableProviderEndpoints.map((endpoint) => (
                <div key={endpoint.id} className="list-row">
                  <div className="flex items-center justify-between gap-2 w-full min-w-0">
                    <div className="min-w-0">
                      <div className="mono-data truncate">{endpoint.url}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="pill">{endpoint.pluginId}</span>
                        {endpoint.label && (
                          <span className="text-xs text-muted">
                            {endpoint.label}
                          </span>
                        )}
                        <ProviderHealthChip
                          checkState={providerChecks[endpoint.id]}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Tooltip label="Verify now">
                        <button
                          className="btn btn-sm btn-secondary-borderless"
                          disabled={providerChecks[endpoint.id] === 'checking'}
                          onClick={() =>
                            chainsApi
                              .checkProviderRpc(chainId, endpoint)
                              .forEach((action) => dispatch(action))
                          }
                          aria-label={`Verify ${endpoint.url}`}
                        >
                          <Activity size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              ))}
              {needsConfigProviders.map((provider) => (
                <div key={provider.pluginId} className="list-row text-muted">
                  <div className="flex items-center justify-between gap-2 w-full min-w-0">
                    <span className="truncate">
                      {provider.name} — needs configuration
                    </span>
                    <button
                      className="btn btn-sm btn-secondary-borderless shrink-0"
                      onClick={() =>
                        dispatch(
                          openConfigModal({ pluginId: provider.pluginId })
                        )
                      }
                    >
                      <Settings2 size={14} />
                      Configure
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      {!rpcsLoading && suggestions.length > 0 && (
        <div className="grid gap-1 mb-3">
          <div className="eyebrow">Public suggestions</div>
          <div className="glass-list">
            {suggestions.slice(0, 6).map((url) => (
              <div key={url} className="list-row">
                <div className="flex items-center justify-between gap-2 w-full min-w-0">
                  <span className="mono-data truncate text-muted">{url}</span>
                  <button
                    className="btn btn-sm btn-secondary shrink-0"
                    onClick={() =>
                      dispatch(
                        chainsApi.addRpc(chainId, {
                          url,
                          source: 'chainlist',
                        })
                      )
                    }
                  >
                    <Plus size={14} />
                    Add
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
