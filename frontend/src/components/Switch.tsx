import * as SwitchPr from '@radix-ui/react-switch';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
}

// Reusable iOS-style switch using Radix
export default function Switch({
  checked,
  onCheckedChange,
  label,
}: SwitchProps) {
  return (
    <label className="flex items-center gap-3">
      {label && <span className="text-sm">{label}</span>}
      <SwitchPr.Root
        className="switch-root"
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      >
        <SwitchPr.Thumb className="switch-thumb" />
      </SwitchPr.Root>
    </label>
  );
}
