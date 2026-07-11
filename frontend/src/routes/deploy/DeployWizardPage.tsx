import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../../store';
import { reorderSteps } from '../../store/features/deployments/deployDraftSlice';
import WizardStepper from './components/WizardStepper';
import ContractsStep from './steps/ContractsStep';
import ChainsStep from './steps/ChainsStep';
import SignersStep from './steps/SignersStep';
import ArgumentsStep from './steps/ArgumentsStep';
import ReviewStep from './steps/ReviewStep';
import { planFromDraft } from './planFromDraft';

const STEPS = [
  { id: 'contracts', label: 'Contracts' },
  { id: 'chains', label: 'Chains & RPCs' },
  { id: 'signers', label: 'Signers' },
  { id: 'arguments', label: 'Arguments' },
  { id: 'review', label: 'Review' },
];

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
  const [step, setStep] = useState(0);
  const [contractsValid, setContractsValid] = useState(false);
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
          onClick={() => navigate(-1)}
        >
          <ArrowLeft size={18} />
        </button>
        <div>
          <h1 className="page-title mb-0">Deploy contracts</h1>
          <p className="text-sm text-muted">
            Create a frozen, recoverable deployment run.
          </p>
        </div>
      </div>
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
            onReorder={(fromIndex, toIndex) =>
              dispatch(reorderSteps({ fromIndex, toIndex }))
            }
          />
        )}
        {step === 1 && <ChainsStep />}
        {step === 2 && <SignersStep />}
        {step === 3 && <ArgumentsStep />}
        {step === 4 && plan && <ReviewStep plan={plan} />}
      </div>
    </div>
  );
}
