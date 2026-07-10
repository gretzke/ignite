import Switch from '../../../components/Switch';

export interface AbiInput {
  name?: string;
  type: string;
  components?: AbiInput[];
}

interface AbiArgFieldProps {
  input: AbiInput;
  fieldKey: string;
  value: unknown;
  onChange: (value: unknown) => void;
}

function inputHint(type: string): string {
  if (/^u?int/.test(type)) return 'Decimal integer';
  if (type === 'address') return '0x… address';
  if (/^bytes/.test(type)) return '0x… hex bytes';
  if (type.endsWith(']')) return 'JSON array';
  return type;
}

export default function AbiArgField({
  input,
  fieldKey,
  value,
  onChange,
}: AbiArgFieldProps) {
  const label = input.name || fieldKey;
  if (input.type === 'bool') {
    return (
      <div className="grid gap-1">
        <span className="text-sm font-medium">{label}</span>
        <Switch
          label={`${label} (${input.type})`}
          checked={value === true || value === 'true'}
          onCheckedChange={onChange}
        />
      </div>
    );
  }

  if (input.type.startsWith('tuple') && !input.type.endsWith(']')) {
    const tuple =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : {};
    return (
      <fieldset className="card-milky p-3 grid gap-3">
        <legend className="text-sm font-medium px-1">
          {label} <span className="mono-data text-muted">{input.type}</span>
        </legend>
        {(input.components ?? []).map((component, index) => {
          const key = component.name || `arg${index}`;
          return (
            <AbiArgField
              key={key}
              input={component}
              fieldKey={key}
              value={tuple[key]}
              onChange={(next) => onChange({ ...tuple, [key]: next })}
            />
          );
        })}
      </fieldset>
    );
  }

  const stringValue =
    value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  return (
    <label className="grid gap-1">
      <span className="text-sm font-medium">
        {label} <span className="mono-data text-muted">{input.type}</span>
      </span>
      <input
        className="input-glass"
        value={stringValue}
        placeholder={inputHint(input.type)}
        inputMode={/^u?int/.test(input.type) ? 'numeric' : undefined}
        onChange={(event) => {
          const next = event.target.value;
          if (input.type.endsWith(']')) {
            try {
              onChange(JSON.parse(next));
            } catch {
              onChange(next);
            }
          } else {
            onChange(next);
          }
        }}
      />
    </label>
  );
}
