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

export default function DeployWizardPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const draft = useAppSelector((state) => state.deployDraft);
  const chains = useAppSelector((state) => state.chains.chains);
  const [step, setStep] = useState(0);
  const plan = useMemo(() => {
    try {
      return planFromDraft(draft, chains);
    } catch {
      return null;
    }
  }, [draft, chains]);
  const resolvedSigners = draft.chains.every(
    (chainId) =>
      draft.signers.perChain?.[String(chainId)] || draft.signers.global
  );
  const valid = [
    draft.contracts.length > 0,
    draft.chains.length > 0 &&
      draft.chains.every((chainId) => draft.rpcSelection[String(chainId)]),
    resolvedSigners,
    Boolean(plan),
    true,
  ];

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
      <div className="card-milky p-5">
        {step === 0 && (
          <ContractsStep
            contracts={draft.contracts}
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
      {step < STEPS.length - 1 && (
        <div className="flex justify-between mt-4">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={step === 0}
            onClick={() => setStep((value) => value - 1)}
          >
            <ArrowLeft size={15} /> Back
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!valid[step]}
            onClick={() => setStep((value) => value + 1)}
          >
            Continue <ArrowRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
