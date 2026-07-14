import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Save, Trash2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store';
import { apiClient } from '../../store/api/client';
import { mergeChainsSucceeded } from '../../store/features/chains/chainsSlice';
import {
  markDraftSeen,
  clearDraft,
  removeContract,
  hydrateWorkflowDraft,
} from '../../store/features/deployments/deployDraftSlice';
import ConfirmDialog from '../../components/ConfirmDialog';
import WizardStepper from './components/WizardStepper';
import ContractsStep from './steps/ContractsStep';
import ChainsStep from './steps/ChainsStep';
import ExplorersStep from './steps/ExplorersStep';
import SignersStep from './steps/SignersStep';
import StepsStep from './steps/StepsStep';
import ReviewStep from './steps/ReviewStep';
import { planFromDraft } from './planFromDraft';
import type { ExplorerEntry } from '@ignite/api';
import { replaceIdsForDisplay } from '../../utils/displayText';
import { workflowsApi } from '../../store/features/workflows/workflowsApi';
import { selectWorkflowDocument } from '../../store/features/workflows/workflowsSlice';
import {
  workflowDocumentFromDraft,
  workflowDraftIsDirty,
} from '../../store/features/deployments/workflowDraft';
import { collectUnboundWorkflowSlots, projectWorkflowPlan } from './projection';
import { cloneJson } from '../../utils/cloneJson';
import PromoteWorkflowDialog from '../../components/PromoteWorkflowDialog';

const STEPS = [
  { id: 'contracts', label: 'Contracts' },
  { id: 'chains', label: 'Chains & RPCs' },
  { id: 'explorers', label: 'Explorers' },
  { id: 'signers', label: 'Signers' },
  { id: 'steps', label: 'Steps' },
  { id: 'review', label: 'Review' },
];

export function explorerBlocker(
  chainIds: number[],
  selection: Record<string, string[]>,
  entriesByChain: Record<string, ExplorerEntry[] | undefined>,
  chainName: (chainId: number) => string
): string | undefined {
  for (const chainId of chainIds) {
    const selected = new Set(selection[String(chainId)] ?? []);
    const entries = entriesByChain[String(chainId)] ?? [];
    const unmapped = entries.find(
      (entry) => selected.has(entry.id) && !entry.verifierPluginId
    );
    if (unmapped)
      return `${chainName(chainId)}: ${unmapped.label ?? unmapped.url} needs a verifier type`;
    const needsConfig = entries.find(
      (entry) => selected.has(entry.id) && entry.needsConfig
    );
    if (needsConfig)
      return `${chainName(chainId)}: ${needsConfig.label ?? needsConfig.url} needs configuration`;
  }
  return undefined;
}

function WizardNav({
  step,
  blocker,
  onBack,
  onContinue,
}: {
  step: number;
  blocker?: string;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={step === 0}
        onClick={onBack}
      >
        <ArrowLeft size={15} /> Back
      </button>
      <div className="flex items-center gap-3 min-w-0">
        {blocker && (
          <span className="text-sm text-warn truncate">{blocker}</span>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={Boolean(blocker)}
          onClick={onContinue}
        >
          Continue <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

export default function DeployWizardPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const stateExplorers = useAppSelector((state) => state.explorers.byChain);
  const [step, setStep] = useState(0);
  const [contractsValid, setContractsValid] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const workflowRepo = searchParams.get('workflowRepo');
  const workflowName = searchParams.get('workflow');
  const workflowState = useAppSelector((state) =>
    workflowRepo && workflowName
      ? selectWorkflowDocument(state, workflowRepo, workflowName)
      : undefined
  );
  const draftActive = draft.contracts.length > 0;
  const stepLabels = Object.fromEntries(
    draft.steps.map((draftStep, index) => [
      draftStep.id,
      draftStep.kind === 'deploy'
        ? (draft.contracts.find(
            (contract) => contract.id === draftStep.contractId
          )?.contractName ?? draftStep.id)
        : draftStep.signature
          ? `Call ${draftStep.signature}`
          : `Call #${index + 1}`,
    ])
  );

  // Visiting the wizard is what "sees" pending additions: clear the sidebar
  // badge on mount.
  useEffect(() => {
    dispatch(markDraftSeen());
  }, [dispatch]);
  // A restored draft can select chains the store has never fetched (they are
  // only ever loaded via the Chains step's search); every wizard step needs
  // their metadata (names, native-currency decimals), so backfill by id.
  useEffect(() => {
    const missing = draft.chains.filter(
      (chainId) => !chains.some((chain) => chain.chainId === chainId)
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      missing.map((chainId) =>
        apiClient
          .request('listChains', { query: { q: String(chainId), limit: 50 } })
          .then((response) =>
            'data' in response
              ? response.data.chains.filter(
                  (chain) => chain.chainId === chainId
                )
              : []
          )
          .catch(() => [])
      )
    ).then((results) => {
      const found = results.flat();
      if (!cancelled && found.length) dispatch(mergeChainsSucceeded(found));
    });
    return () => {
      cancelled = true;
    };
  }, [chains, dispatch, draft.chains]);
  useEffect(() => {
    if (workflowRepo && workflowName && !workflowState)
      dispatch(workflowsApi.get(workflowRepo, workflowName));
  }, [dispatch, workflowName, workflowRepo, workflowState]);
  useEffect(() => {
    if (!workflowRepo || !workflowName || !workflowState) return;
    if (
      draft.workflowRef?.repoPathOrUrl === workflowRepo &&
      draft.workflowRef.name === workflowName
    )
      return;
    dispatch(
      hydrateWorkflowDraft({
        repoPathOrUrl: workflowRepo,
        name: workflowName,
        docHash: workflowState.docHash,
        document: workflowState.document,
      })
    );
  }, [
    dispatch,
    draft.workflowRef?.name,
    draft.workflowRef?.repoPathOrUrl,
    workflowName,
    workflowRepo,
    workflowState,
  ]);
  const { plan, planProblem } = useMemo(() => {
    try {
      if (draft.workflowRef && draft.workflowDocument) {
        const projected = projectWorkflowPlan({
          document: workflowDocumentFromDraft(draft),
          repoPathOrUrl: draft.workflowRef.repoPathOrUrl,
          chains: draft.chains,
          includedStepIds: draft.workflowIncludedStepIds ?? {},
          resolutions: draft.externalResolutions ?? [],
        });
        return {
          plan: { ...projected, signers: cloneJson(draft.signers) },
          planProblem: undefined,
        };
      }
      return { plan: planFromDraft(draft, chains), planProblem: undefined };
    } catch (error) {
      return {
        plan: null,
        planProblem:
          error instanceof Error ? error.message : 'The plan is incomplete',
      };
    }
  }, [draft, chains]);
  const chainName = (chainId: number) =>
    chains.find((chain) => chain.chainId === chainId)?.name ??
    `Chain ${chainId}`;

  // The first reason the current step cannot continue — surfaced next to the
  // disabled button. A silently disabled Continue with the offending chain
  // scrolled off-screen reads as a dead end.
  const blockers: Array<string | undefined> = [
    contractsValid ? undefined : 'Select at least one deployable contract',
    (() => {
      if (draft.chains.length === 0) return 'Select at least one chain';
      const missing = draft.chains.find(
        (chainId) => !draft.rpcSelection[String(chainId)]
      );
      return missing === undefined
        ? undefined
        : `${chainName(missing)} needs an RPC endpoint`;
    })(),
    explorerBlocker(
      draft.chains,
      draft.explorerSelection,
      stateExplorers,
      chainName
    ),
    (() => {
      const unresolved = draft.chains.find(
        (chainId) =>
          !draft.signers.perChain?.[String(chainId)] && !draft.signers.global
      );
      return unresolved === undefined
        ? undefined
        : `${chainName(unresolved)} has no signer`;
    })(),
    (() => {
      if (planProblem) return planProblem;
      if (!draft.workflowDocument) return undefined;
      const slots = collectUnboundWorkflowSlots({
        document: workflowDocumentFromDraft(draft),
        repoPathOrUrl: draft.workflowRef!.repoPathOrUrl,
        chains: draft.chains,
        includedStepIds: draft.workflowIncludedStepIds ?? {},
        resolutions: draft.externalResolutions,
      });
      return slots.length
        ? `Resolve ${slots.length} per-chain pointer ${slots.length === 1 ? 'slot' : 'slots'}`
        : undefined;
    })(),
    undefined,
  ];

  const nav = step < STEPS.length - 1 && (
    <WizardNav
      step={step}
      blocker={
        blockers[step]
          ? replaceIdsForDisplay(blockers[step], stepLabels)
          : undefined
      }
      onBack={() => setStep((value) => value - 1)}
      onContinue={() => setStep((value) => value + 1)}
    />
  );

  return (
    <div className="text-[var(--text)] max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          aria-label="Back"
          onClick={() => navigate('/deployments')}
        >
          <ArrowLeft size={18} />
        </button>
        {draftActive && (
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Discard deployment"
            title="Discard deployment"
            onClick={() => setConfirmDiscard(true)}
          >
            <Trash2 size={18} />
          </button>
        )}
        <div className="flex-1">
          <h1 className="page-title mb-0">Deploy contracts</h1>
          <p className="text-sm text-muted">
            Create a frozen, recoverable deployment run.
          </p>
        </div>
        {draft.workflowRef && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!workflowDraftIsDirty(draft)}
            onClick={() =>
              dispatch(
                workflowsApi.put(
                  draft.workflowRef!.repoPathOrUrl,
                  draft.workflowRef!.name,
                  workflowDocumentFromDraft(draft),
                  draft.workflowRef!.baseDocHash
                )
              )
            }
          >
            Save workflow{workflowDraftIsDirty(draft) ? ' · unsaved' : ''}
          </button>
        )}
        {draftActive && !draft.workflowRef && plan && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPromoteOpen(true)}
          >
            <Save size={15} /> Save as workflow
          </button>
        )}
      </div>
      {draft.workflowRef && (
        <div className="card-milky px-4 py-3 mb-4 text-sm flex items-center justify-between">
          <span>
            Workflow mode · <strong>{draft.workflowRef.name}</strong>
          </span>
          <span
            className={workflowDraftIsDirty(draft) ? 'text-warn' : 'text-muted'}
          >
            {workflowDraftIsDirty(draft) ? 'Unsaved changes' : 'Saved'}
          </span>
        </div>
      )}
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard deployment?"
        description="Removes every added contract and all configuration in this deployment."
        confirmText="Discard"
        onConfirm={() => {
          dispatch(clearDraft());
          navigate('/deployments', { replace: true });
        }}
      />
      {plan && (
        <PromoteWorkflowDialog
          open={promoteOpen}
          onOpenChange={setPromoteOpen}
          input={{ plan }}
          hooks={draft.workflowOutputs?.hooks ?? []}
          onPromoted={(repoPathOrUrl) =>
            navigate(
              `/repositories/${encodeURIComponent(repoPathOrUrl)}#deployments`
            )
          }
        />
      )}
      <WizardStepper
        steps={STEPS}
        currentIndex={step}
        onStepSelect={(index) => {
          if (index <= step) setStep(index);
        }}
      />
      {nav && <div className="mb-4">{nav}</div>}
      <div className="card-milky p-5">
        {step === 0 && (
          <ContractsStep
            contracts={draft.contracts}
            onValidityChange={setContractsValid}
            onRemove={(contractId) => dispatch(removeContract(contractId))}
            workflowMode={Boolean(draft.workflowRef)}
          />
        )}
        {step === 1 && <ChainsStep />}
        {step === 2 && <ExplorersStep />}
        {step === 3 && <SignersStep />}
        {step === 4 && <StepsStep />}
        {step === 5 && plan && <ReviewStep plan={plan} />}
      </div>
    </div>
  );
}
