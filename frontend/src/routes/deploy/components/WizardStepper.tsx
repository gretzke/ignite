import { Check } from 'lucide-react';

export interface WizardStep {
  id: string;
  label: string;
}

interface WizardStepperProps {
  steps: WizardStep[];
  currentIndex: number;
  onStepSelect?: (index: number) => void;
}

export default function WizardStepper({
  steps,
  currentIndex,
  onStepSelect,
}: WizardStepperProps) {
  return (
    <ol className="card-milky p-3 flex flex-wrap items-center gap-2 mb-5">
      {steps.map((step, index) => {
        const complete = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={step.id} className="flex items-center gap-2">
            <button
              type="button"
              className={`btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}`}
              aria-current={active ? 'step' : undefined}
              disabled={index > currentIndex}
              onClick={() => onStepSelect?.(index)}
            >
              {complete ? <Check size={14} /> : <span>{index + 1}</span>}
              {step.label}
            </button>
            {index < steps.length - 1 && (
              <span className="text-muted" aria-hidden>
                /
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
