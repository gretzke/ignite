import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  DeploymentHookInfo,
  DeploymentPlan,
  ValidationItem,
  ValidationReport,
} from '@ignite/api';
import { sanitizeDisplayText } from '@ignite/api';
import { Loader2, RefreshCw, Rocket } from 'lucide-react';
import { type NavigateFunction, useNavigate } from 'react-router-dom';
import { ApiError } from '@ignite/api/client';
import { apiClient } from '../../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../../store';
import { verifierPluginLabel } from '../../../store/features/plugins/pluginsSlice';
import {
  draftLaunched,
  mintIdempotencyKey,
  setName,
  acknowledgeDeployed,
  setAcknowledgeUninitialized,
  acknowledgeArtifactDrift,
  setWorkflowRunHooks,
} from '../../../store/features/deployments/deployDraftSlice';
import { runSnapshotReceived } from '../../../store/features/deployments/deploymentsSlice';
import ValidationChecklist from '../components/ValidationChecklist';
import { explorersApi } from '../../../store/api/explorersApi';
import { decodeUrlEncodingForDisplay, replaceIdsForDisplay } from '../../../utils/displayText';
import { workflowRunRequestFromDraft } from '../../../store/features/deployments/workflowDraft';
import { openPermissionsModal } from '../../../store/features/plugins/pluginsSlice';
import { reviewPredictedAddresses } from '../reviewPredictions';
import { triggerToast } from '../../../store/middleware/toastListener';
import InstallPluginDialog from '../../../components/plugins/InstallPluginDialog';
import { selectWorkflowDocument } from '../../../store/features/workflows/workflowsSlice';

function validationGreen(report: ValidationReport | null): boolean {
  return Boolean(
    report &&
    Object.values(report.chains).every((checklist) =>
      Object.values(checklist).every((item) => !item.blocking || item.ok)
    ) &&
    Object.values(report.run ?? {}).every((item) => !item?.blocking || item.ok)
  );
}

export function bounceOutOfSyncWorkflowRun(
  cause: unknown,
  dispatch: (action: ReturnType<typeof triggerToast>) => unknown,
  navigate: NavigateFunction
): boolean {
  if (
    !(cause instanceof ApiError) ||
    cause.status !== 409 ||
    cause.body.code !== 'WORKFLOW_OUT_OF_SYNC'
  )
    return false;
  dispatch(
    triggerToast({
      title: 'Workflow is out of sync',
      description: 'Install or update it first.',
      variant: 'error',
      duration: 8000,
    })
  );
  navigate('/workflows', { replace: true });
  return true;
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
  const currentWorkflowDocument = useAppSelector((state) =>
    draft.workflowRef
      ? selectWorkflowDocument(
          state,
          draft.workflowRef.repoPathOrUrl,
          draft.workflowRef.name
        )
      : undefined
  );
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deploymentHooks, setDeploymentHooks] = useState<DeploymentHookInfo[]>(
    []
  );
  const [hooksLoaded, setHooksLoaded] = useState(false);
  const [pluginId, setPluginId] = useState<string | null>(null);
  const defaultName = `Deploy ${draft.contracts
    .map((item) => item.contractName)
    .join(', ')}`;
  const stepLabels = useMemo(
    () =>
      Object.fromEntries(
        plan.steps.map((step, index) => [
          step.id,
          step.kind === 'deploy'
            ? (draft.contracts.find(
                (contract) => contract.id === step.contractId
              )?.contractName ?? decodeUrlEncodingForDisplay(step.id))
            : step.signature
              ? `Call ${step.signature}`
              : `Call #${index + 1}`,
        ])
      ),
    [draft.contracts, plan.steps]
  );
  const wrapperStepIds = useMemo(
    () => new Set(draft.steps.filter((step) => step.kind === 'deploy' && step.wraps).map((step) => step.id)),
    [draft.steps]
  );
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

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .request('listDeploymentHooks', {})
      .then((response) => {
        if ('data' in response && !cancelled)
          setDeploymentHooks(response.data.deploymentHooks);
      })
      .catch(() => {
        // Validation remains authoritative and will surface selected hook
        // warnings; a transient discovery failure must not strand Review.
      })
      .finally(() => {
        if (!cancelled) setHooksLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const installedHookIds = useMemo(
    () => deploymentHooks.map((hook) => hook.pluginId),
    [deploymentHooks]
  );
  const workflowRequest = useMemo(
    () => workflowRunRequestFromDraft(draft, installedHookIds),
    [draft, installedHookIds]
  );
  const selectedHooks = workflowRequest?.hooks ?? [];
  const selectedPlugin = draft.workflowRequiredPlugins?.find(
    (plugin) => plugin.id === pluginId
  );

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
          ...(workflowRequest ? { workflow: workflowRequest } : {}),
        },
      });
      if (!('data' in response)) throw new Error(response.message);
      setReport({
        chains: response.data.chains,
        ...(response.data.run ? { run: response.data.run } : {}),
      });
    } catch (cause) {
      setReport(null);
      if (bounceOutOfSyncWorkflowRun(cause, dispatch, navigate)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [dispatch, draft.explorerSelection, navigate, plan, rpcSelection, workflowRequest]);

  useEffect(() => {
    void validate();
  }, [validate]);

  const launch = async () => {
    if (!draft.idempotencyKey || !validationGreen(report)) return;
    if (
      draft.workflowRef &&
      draft.workflowRef.docHash !== currentWorkflowDocument?.docHash
    ) {
      setError('The workflow changed on disk. Reload its draft before launching.');
      return;
    }
    const launchedKey = draft.idempotencyKey;
    setLaunching(true);
    setError(null);
    try {
      const response = await apiClient.request('createDeploymentRun', {
        body: {
          plan,
          rpcSelection,
          explorerSelection: draft.explorerSelection,
          idempotencyKey: launchedKey,
          name: draft.name?.trim() || defaultName,
          ...(workflowRequest ? { workflow: workflowRequest } : {}),
        },
      });
      if (!('data' in response)) throw new Error(response.message);
      dispatch(runSnapshotReceived(response.data.run));
      dispatch(draftLaunched(launchedKey));
      navigate(`/deployments/${response.data.run.id}`, { replace: true });
    } catch (cause) {
      if (bounceOutOfSyncWorkflowRun(cause, dispatch, navigate)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLaunching(false);
    }
  };

  const acknowledge = (
    chainId: number,
    item: ValidationItem
  ) => {
    if (item.code === 'UNINITIALIZED_PROXY_ACK_REQUIRED') {
      const stepId = item.details?.stepId;
      if (typeof stepId === 'string') {
        dispatch(setAcknowledgeUninitialized({ stepId, acknowledged: true }));
        return;
      }
    }
    const details = item.details ?? {};
    const stepId =
      typeof details.stepId === 'string' ? details.stepId : undefined;
    const predictedAddress =
      typeof details.predictedAddress === 'string'
        ? details.predictedAddress
        : undefined;
    const initcodeHash =
      typeof details.initcodeHash === 'string'
        ? details.initcodeHash
        : undefined;
    if (!stepId || !predictedAddress || !initcodeHash) {
      setError(
        'The validation result did not include the deployment acknowledgement details.'
      );
      return;
    }
    dispatch(
      acknowledgeDeployed({
        stepId,
        chainId,
        predictedAddress: predictedAddress as `0x${string}`,
        initcodeHash: initcodeHash as `0x${string}`,
      })
    );
    // `plan` is rebuilt from the draft by the parent. Its change triggers the
    // validation effect with the acknowledgement included in the payload.
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
      {draft.workflowRef && (
        <section className="card-milky p-4 grid gap-3">
          <div>
            <span className="eyebrow">Outputs</span>
            <p className="text-sm text-muted mt-1">
              Choose deployment hooks for this run. The workflow file is
              unchanged.
            </p>
          </div>
          {!hooksLoaded && (
            <div className="text-sm text-muted flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" /> Loading hooks…
            </div>
          )}
          <div className="glass-list">
            {deploymentHooks.map((hook) => {
              const selected = selectedHooks.includes(hook.pluginId);
              const plugin = pluginRows[hook.pluginId];
              return (
                <div
                  key={hook.pluginId}
                  className="list-row flex items-center gap-3"
                >
                  <label className="flex items-center gap-3 flex-1">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        dispatch(
                          setWorkflowRunHooks(
                            selected
                              ? selectedHooks.filter(
                                  (id) => id !== hook.pluginId
                                )
                              : [...selectedHooks, hook.pluginId]
                          )
                        )
                      }
                    />
                    <span>
                      <span className="font-medium">{hook.label}</span>
                      <span className="text-xs text-muted block">
                        {hook.description}
                      </span>
                    </span>
                  </label>
                  {plugin?.trust === 'untrusted' && (
                    <>
                      <span className="chip chip-warn">untrusted</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() =>
                          dispatch(
                            openPermissionsModal({
                              pluginId: hook.pluginId,
                              newPermissionIds: [],
                            })
                          )
                        }
                      >
                        Review trust
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            {(draft.workflowOutputs?.hooks ?? [])
              .filter((id) => !installedHookIds.includes(id))
              .map((id) => {
                const required = draft.workflowRequiredPlugins?.find(
                  (plugin) => plugin.id === id
                );
                return (
                  <div key={id} className="list-row flex items-center gap-3">
                    <div className="flex-1">
                      <span className="font-medium mono-data">
                        {sanitizeDisplayText(id)}
                      </span>
                      <span className="text-xs text-warn block">
                        Required by the workflow but not installed; it will not
                        run.
                      </span>
                    </div>
                    {required?.source ? (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => setPluginId(required.id)}
                      >
                        Install
                      </button>
                    ) : (
                      <span className="text-xs text-muted">
                        Install manually in Plugins
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      )}
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
      {error && (
        <div className="card-milky p-4 text-err">
          {sanitizeDisplayText(replaceIdsForDisplay(error, stepLabels))}
        </div>
      )}
      {report && (
        <ValidationChecklist
          chains={report.chains}
          run={report.run}
          chainInfo={chains}
          stepLabels={stepLabels}
          onAcknowledge={acknowledge}
          onAcceptArtifactDrift={(drifts) => {
            for (const drift of drifts)
              dispatch(acknowledgeArtifactDrift(drift));
          }}
        />
      )}
      {reviewPredictedAddresses(report).length > 0 && (
        <section className="card-milky p-4 grid gap-2">
          <h3 className="font-semibold">Predicted addresses</h3>
          {reviewPredictedAddresses(report).map(
            ({ chainId, stepId, address, provisional, provisionalLabel }) => {
              const contractId = draft.steps.find(
                (step) => step.id === stepId && step.kind === 'deploy'
              )?.contractId;
              const name =
                draft.contracts.find((contract) => contract.id === contractId)
                  ?.contractName ?? decodeUrlEncodingForDisplay(stepId);
              return (
                <div
                  key={`${stepId}-${chainId}`}
                  className="list-row flex gap-3"
                >
                  <span className="font-medium">{name}{wrapperStepIds.has(stepId) && ' (wrapper)'}</span>
                  <span className="text-muted">
                    {chains.find((chain) => String(chain.chainId) === chainId)
                      ?.name ?? `Chain ${chainId}`}
                  </span>
                  {provisional && (
                    <span className="chip">
                      {provisionalLabel ?? 'provisional'}
                    </span>
                  )}
                  <span className="mono-data ml-auto">{address}</span>
                </div>
              );
            }
          )}
        </section>
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
      <InstallPluginDialog
        open={pluginId !== null}
        onOpenChange={(open) => !open && setPluginId(null)}
        requiredPlugin={selectedPlugin}
      />
    </section>
  );
}
