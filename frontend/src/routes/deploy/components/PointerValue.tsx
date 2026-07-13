import type { ValueRef } from '@ignite/api';

export interface PointerOption {
  stepId: string;
  label: string;
  disabledReason?: string;
}

export default function PointerValue({
  value,
  onChange,
  eligibleSteps,
}: {
  value: string | ValueRef | undefined;
  onChange: (value: string | ValueRef | undefined) => void;
  eligibleSteps: PointerOption[];
}) {
  const pointer =
    value && typeof value === 'object' && '$ref' in value
      ? (value as ValueRef)
      : undefined;
  const selected = pointer?.$ref.stepId;
  return (
    <div className="grid gap-2">
      <div className="flex gap-2" role="group" aria-label="Address value mode">
        <button
          type="button"
          className={`btn btn-sm ${pointer ? 'btn-secondary' : 'btn-primary'}`}
          onClick={() => onChange(typeof value === 'string' ? value : '')}
        >
          Literal
        </button>
        <button
          type="button"
          className={`btn btn-sm ${pointer ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => onChange({ $ref: { kind: 'step', stepId: eligibleSteps.find((item) => !item.disabledReason)?.stepId ?? '' } })}
          disabled={!eligibleSteps.some((item) => !item.disabledReason)}
        >
          Pointer
        </button>
      </div>
      {pointer ? (
        <select
          className="input-glass"
          value={selected ?? ''}
          onChange={(event) => onChange({ $ref: { kind: 'step', stepId: event.target.value } })}
        >
          <option value="">Choose a deployment</option>
          {eligibleSteps.map((item) => (
            <option key={item.stepId} value={item.stepId} disabled={Boolean(item.disabledReason)}>
              {item.disabledReason ? `${item.label} — ${item.disabledReason}` : item.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
