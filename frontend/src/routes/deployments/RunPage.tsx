import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Ban, Loader2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import type {
  ResolveAction,
  ResolveLaneRequest,
  SignerProviderAccounts,
  SignerRef,
} from '@ignite/api';
import { apiClient } from '../../store/api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  runSnapshotReceived,
  runViewMounted,
  runViewUnmounted,
  selectDeploymentRun,
} from '../../store/features/deployments/deploymentsSlice';
import { chainsApi } from '../../store/features/chains/chainsSlice';
import { signersApi } from '../../store/features/signers/signersSlice';
import LanePanel from './components/LanePanel';
import ResolveEditDialog from './components/ResolveEditDialog';
import ConfirmDialog from '../../components/ConfirmDialog';

function signerFor(
  ref: SignerRef | undefined,
  providers: SignerProviderAccounts[]
) {
  if (!ref) return undefined;
  return providers
    .flatMap((provider) =>
      provider.accounts.map((account) => ({ provider, account }))
    )
    .find(
      (item) =>
        item.provider.pluginId === ref.pluginId &&
        item.account.id === ref.accountId
    )?.account;
}

export default function RunPage() {
  const { runId = '' } = useParams<{ runId: string }>();
  const dispatch = useAppDispatch();
  const run = useAppSelector((state) => selectDeploymentRun(state, runId));
  const chains = useAppSelector((state) => state.chains);
  const providers = useAppSelector((state) => state.signers.providers);
  const [loading, setLoading] = useState(!run);
  const [error, setError] = useState<string | null>(null);
  const [editChainId, setEditChainId] = useState<number | null>(null);
  const [abortOpen, setAbortOpen] = useState(false);

  useEffect(() => {
    dispatch(runViewMounted(runId));
    return () => {
      dispatch(runViewUnmounted(runId));
    };
  }, [dispatch, runId]);

  useEffect(() => {
    if (run) return;
    void apiClient
      .request('getDeploymentRun', { params: { runId } })
      .then((response) => {
        if (!('data' in response)) throw new Error(response.message);
        dispatch(runSnapshotReceived(response.data.run));
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause))
      )
      .finally(() => setLoading(false));
  }, [dispatch, run, runId]);

  useEffect(() => {
    chainsApi.fetchChains(undefined, 500).forEach((action) => dispatch(action));
    signersApi.listAccounts(true).forEach((action) => dispatch(action));
  }, [dispatch]);

  useEffect(() => {
    run?.plan.chains.forEach((chainId) =>
      dispatch(chainsApi.fetchRpcs(chainId, true))
    );
  }, [dispatch, run?.plan.chains]);

  const contractNames = useMemo(
    () =>
      Object.fromEntries(
        (run?.plan.contracts ?? []).map((contract) => [
          contract.id,
          contract.contractName,
        ])
      ),
    [run?.plan.contracts]
  );

  if (loading && !run)
    return (
      <div className="card-milky p-8 flex justify-center gap-2 text-muted">
        <Loader2 size={18} className="animate-spin" /> Loading deployment…
      </div>
    );
  if (!run)
    return (
      <div className="card-milky p-6 text-err">
        {error ?? 'Deployment run not found.'}
      </div>
    );

  const attemptFor = (chainId: number) => {
    const lane = run.lanes[String(chainId)];
    return lane.pause
      ? lane.steps[lane.pause.stepIndex]?.attempts.find(
          (item) => item.id === lane.pause?.attemptId
        )
      : undefined;
  };

  const sendResolution = async (chainId: number, body: ResolveLaneRequest) => {
    setError(null);
    try {
      const response = await apiClient.request('resolveDeploymentLane', {
        params: { runId, chainId: String(chainId) },
        body,
      });
      if (!('data' in response)) throw new Error(response.message);
      dispatch(runSnapshotReceived(response.data.run));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const act = (chainId: number, action: ResolveAction) => {
    const attempt = attemptFor(chainId);
    if (!attempt) return;
    const base = {
      action,
      attemptId: attempt.id,
      commandId: globalThis.crypto.randomUUID(),
    };
    if (action === 'edit') {
      setEditChainId(chainId);
      return;
    }
    if (action === 'confirm-hash') {
      const txHash = window.prompt('Paste the mined transaction hash');
      if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        setError('Enter a 32-byte 0x transaction hash.');
        return;
      }
      void sendResolution(chainId, {
        ...base,
        action,
        txHash: txHash as `0x${string}`,
      });
      return;
    }
    if (action === 'replace') {
      const maxFeePerGas = window.prompt('Replacement max fee per gas (wei)');
      const maxPriorityFeePerGas = window.prompt(
        'Replacement priority fee per gas (wei)'
      );
      if (
        !maxFeePerGas ||
        !maxPriorityFeePerGas ||
        !/^\d+$/.test(maxFeePerGas) ||
        !/^\d+$/.test(maxPriorityFeePerGas)
      ) {
        setError('Replacement fees must be decimal wei integers.');
        return;
      }
      void sendResolution(chainId, {
        ...base,
        action,
        gas: { maxFeePerGas, maxPriorityFeePerGas },
      });
      return;
    }
    void sendResolution(chainId, base as ResolveLaneRequest);
  };

  const abort = async () => {
    const response = await apiClient.request('abortDeploymentRun', {
      params: { runId },
    });
    if ('data' in response) dispatch(runSnapshotReceived(response.data.run));
  };

  return (
    <div className="text-[var(--text)] grid gap-4">
      <header className="flex items-center gap-3">
        <Link
          to="/deployments"
          className="btn btn-secondary btn-icon"
          aria-label="Back to deployments"
        >
          <ArrowLeft size={18} />
        </Link>
        <div className="min-w-0">
          <h1 className="page-title mb-0 truncate">{run.name}</h1>
          <span className="mono-data text-muted">{run.id}</span>
        </div>
        <span
          className={`chip ml-auto ${run.status === 'completed' ? 'chip-ok' : run.status === 'paused' ? 'chip-warn' : ''}`}
        >
          <span className="chip-dot" />
          {run.status}
        </span>
        {!['completed', 'failed', 'aborted'].includes(run.status) && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => setAbortOpen(true)}
          >
            <Ban size={15} /> Abort run
          </button>
        )}
      </header>
      {error && <div className="card-milky p-3 text-err">{error}</div>}
      <div className="grid gap-4">
        {run.plan.chains.map((chainId) => {
          const lane = run.lanes[String(chainId)];
          if (!lane) return null;
          const currentPlanStep =
            run.plan.steps[lane.pause?.stepIndex ?? lane.currentStepIndex];
          const ref =
            currentPlanStep?.signerOverride?.perChain?.[String(chainId)] ??
            currentPlanStep?.signerOverride?.global ??
            run.plan.signers.perChain?.[String(chainId)] ??
            run.plan.signers.global;
          const account = signerFor(ref, providers);
          const pausedAttempt = lane.pause
            ? lane.steps[lane.pause.stepIndex]?.attempts.find(
                (attempt) => attempt.id === lane.pause?.attemptId
              )
            : undefined;
          const capability =
            account?.capability ??
            (pausedAttempt?.rawTx ? 'sign-only' : undefined);
          return (
            <LanePanel
              key={chainId}
              lane={lane}
              chain={chains.chains.find((item) => item.chainId === chainId)}
              planSteps={run.plan.steps}
              contractNames={contractNames}
              capability={capability}
              onAction={(action) => act(chainId, action)}
            />
          );
        })}
      </div>
      {editChainId !== null &&
        (() => {
          const attempt = attemptFor(editChainId);
          const endpoints = [
            ...(chains.rpcByChain[String(editChainId)] ?? []),
            ...(chains.providerRpcByChain[String(editChainId)] ?? []),
          ].filter((endpoint) => {
            if (endpoint.lastVerification?.ok) return true;
            const providerCheck = chains.providerChecks[endpoint.id];
            return providerCheck !== 'checking' && providerCheck?.ok === true;
          });
          return (
            <ResolveEditDialog
              open
              onOpenChange={(open) => {
                if (!open) setEditChainId(null);
              }}
              endpoints={endpoints}
              initialRpcEndpointId={
                run.rpcSelection[String(editChainId)]?.endpointId
              }
              onSubmit={(edits) => {
                if (attempt)
                  void sendResolution(editChainId, {
                    action: 'edit',
                    attemptId: attempt.id,
                    commandId: globalThis.crypto.randomUUID(),
                    edits,
                  });
              }}
            />
          );
        })()}
      <ConfirmDialog
        open={abortOpen}
        onOpenChange={setAbortOpen}
        title="Abort this deployment run?"
        description="Every lane will stop at its next durable safe point. In-flight transactions may still mine."
        confirmText="Abort run"
        onConfirm={() => void abort()}
      />
    </div>
  );
}
