import type { ArgValues } from '@ignite/api';
import AbiArgField, { type AbiInput } from '../routes/deploy/components/AbiArgField';

export interface ConstructorAbiEntry {
  type?: string;
  inputs?: AbiInput[];
}

export function constructorInputs(abi: ConstructorAbiEntry[] | undefined) {
  return abi?.find((entry) => entry.type === 'constructor')?.inputs ?? [];
}

export default function ConstructorArgsForm({
  abi,
  value,
  onChange,
}: {
  abi: ConstructorAbiEntry[] | undefined;
  value: ArgValues;
  onChange: (value: ArgValues) => void;
}) {
  return (
    <div className="grid gap-3">
      {constructorInputs(abi).map((input, index) => {
        const key = input.name || `arg${index}`;
        return (
          <AbiArgField
            key={key}
            input={input}
            fieldKey={key}
            value={value[key]}
            autoDefault
            onChange={(next) => onChange({ ...value, [key]: next })}
          />
        );
      })}
    </div>
  );
}
