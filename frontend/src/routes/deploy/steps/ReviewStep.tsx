import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeploymentPlan, ValidationReport } from '@ignite/api';
import { Loader2, RefreshCw, Rocket } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store';
import { verifierPluginLabel } from '../../../store/features/plugins/pluginsSlice';
import {
  clearDraft,
  mintIdempotencyKey,
  setName,
} from '../../../store/features/deployments/deployDraftSlice';
import { runSnapshotReceived } from '../../../store/features/deployments/deploymentsSlice';
import ValidationChecklist from '../components/ValidationChecklist';
import { explorersApi } from '../../../store/api/explorersApi';

function validationGreen(report: ValidationReport | null): boolean {
  return Boolean(
    report &&
    Object.values(report.chains).every((checklist) =>
      Object.values(checklist).every((item) => !item.blocking || item.ok)
    )
  );
}

interface ReviewStepProps {
  plan: DeploymentPlan;
}

export default function ReviewStep({ plan }: ReviewStepProps) {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const explorers = useAppSelector((state) => state.explorers.byChain);
  const pluginRows = useAppSelector((state) => state.plugins.rows);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const defaultName = `Deploy ${draft.contracts
    .map((item) => item.contractName)
    .join(', ')}`;
  const rpcSelection = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(draft.rpcSelection).map(([chainId, rpc]) => [
          chainId,
          rpc.endpointId,
        ])
      ),
    [draft.rpcSelection]
  );

  useEffect(() => {
    if (!draft.idempotencyKey) dispatch(mintIdempotencyKey());
  }, [dispatch, draft.idempotencyKey]);

  // Explorer entries are normally loaded in the preceding step. Fetch any
  // missing chain here too, so the review always has each selected URL rather
  // than falling back to an opaque entry id.
  useEffect(() => {
    Object.entries(draft.explorerSelection).forEach(([chainId, entryIds]) => {
      if (entryIds.length > 0 && explorers[chainId] === undefined) {
        explorersApi
          .fetchExplorers(Number(chainId))
          .forEach((action) => dispatch(action));
      }
    });
  }, [dispatch, draft.explorerSelection, explorers]);

  const validate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.request('validateDeployment', {
        body: {
          plan,
          rpcSelection,
          explorerSelection: draft.explorerSelection,
        },
      });
      if (!('data' in response)) throw new Error(response.message);
      setReport({ chains: response.data.chains });
    } catch (cause) {
      setReport(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [draft.explorerSelection, plan, rpcSelection]);

  useEffect(() => {
    void validate();
  }, [validate]);

  const launch = async () => {
    if (!draft.idempotencyKey || !validationGreen(report)) return;
    setLaunching(true);
    setError(null);
    try {
      const response = await apiClient.request('createDeploymentRun', {
        body: {
          plan,
          rpcSelection,
          explorerSelection: draft.explorerSelection,
          idempotencyKey: draft.idempotencyKey,
          name: draft.name?.trim() || defaultName,
        },
      });
      if (!('data' in response)) throw new Error(response.message);
      dispatch(runSnapshotReceived(response.data.run));
      dispatch(clearDraft());
      navigate(`/deployments/${response.data.run.id}`, { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className="grid gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Review & validate</h2>
          <p className="text-sm text-muted">
            Validation freezes artifacts, checks every signer and estimates
            every constructor.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={loading}
          onClick={() => void validate()}
        >
          <RefreshCw size={14} /> Re-validate
        </button>
      </div>
      <label className="card-milky p-4 grid gap-1">
        <span className="eyebrow">Run name</span>
        <input
          className="input-glass"
          value={draft.name ?? ''}
          placeholder={defaultName}
          onChange={(event) =>
            dispatch(setName(event.target.value || undefined))
          }
        />
      </label>
      {Object.entries(draft.explorerSelection).some(
        ([, ids]) => ids.length > 0
      ) && (
        <div className="card-milky p-4 grid gap-2">
          <span className="eyebrow">Selected explorers</span>
          {Object.entries(draft.explorerSelection).map(([chainId, ids]) => {
            if (ids.length === 0) return null;
            const entries = explorers[chainId];
            return (
              <div key={chainId} className="grid gap-1">
                <h3 className="eyebrow">
                  {chains.find((chain) => String(chain.chainId) === chainId)
                    ?.name ?? `Chain ${chainId}`}
                </h3>
                <div className="glass-list">
                  {ids.map((entryId) => {
                    const entry = entries?.find(
                      (candidate) => candidate.id === entryId
                    );
                    return (
                      <div key={entryId} className="list-row min-w-0">
                        <div className="font-medium truncate">
                          {entry
                            ? verifierPluginLabel(
                                pluginRows,
                                entry.verifierPluginId
                              )
                            : 'Loading explorer details…'}
                        </div>
                        <div className="mono-data text-muted truncate">
                          {entry?.url ?? 'Loading explorer URL…'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {loading && (
        <div className="card-milky p-6 flex justify-center items-center gap-2 text-muted">
          <Loader2 size={18} className="animate-spin" /> Validating the full
          plan…
        </div>
      )}
      {error && <div className="card-milky p-4 text-err">{error}</div>}
      {report && (
        <ValidationChecklist chains={report.chains} chainInfo={chains} />
      )}
      <div className="flex justify-end">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            !validationGreen(report) || launching || !draft.idempotencyKey
          }
          onClick={() => void launch()}
        >
          {launching ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Rocket size={16} />
          )}{' '}
          Launch deployment
        </button>
      </div>
    </section>
  );
}
