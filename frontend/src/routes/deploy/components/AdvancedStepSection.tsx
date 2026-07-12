import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export default function AdvancedStepSection({
  children,
  label = 'Advanced transaction settings',
  compact = false,
}: {
  children: ReactNode;
  label?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className={compact ? '' : 'border-t border-[var(--hairline)] pt-3'}
    >
      <button
        type="button"
        className={`btn btn-sm btn-secondary-borderless${
          compact ? ' -ml-2 px-2 py-2' : ''
        }`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {label}
      </button>
      {open && (
        <div className={`grid gap-3${compact ? ' mt-2' : ' mt-3'}`}>
          {children}
        </div>
      )}
    </section>
  );
}
