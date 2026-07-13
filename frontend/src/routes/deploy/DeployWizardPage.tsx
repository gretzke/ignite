import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  markDraftSeen,
  clearDraft,
  removeContract,
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
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const stateExplorers = useAppSelector((state) => state.explorers.byChain);
  const [step, setStep] = useState(0);
  const [contractsValid, setContractsValid] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const draftActive = draft.contracts.length > 0;

  // Visiting the wizard is what "sees" pending additions: clear the sidebar
  // badge on mount.
  useEffect(() => {
    dispatch(markDraftSeen());
  }, [dispatch]);
  const { plan, planProblem } = useMemo(() => {
    try {
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
    planProblem,
    undefined,
  ];

  const nav = step < STEPS.length - 1 && (
    <WizardNav
      step={step}
      blocker={blockers[step]}
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
        <div>
          <h1 className="page-title mb-0">Deploy contracts</h1>
          <p className="text-sm text-muted">
            Create a frozen, recoverable deployment run.
          </p>
        </div>
      </div>
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
