import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export default function AdvancedStepSection({
  children,
}: {
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-t border-[var(--hairline)] pt-3">
      <button
        type="button"
        className="btn btn-sm btn-secondary-borderless"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        Advanced transaction settings
      </button>
      {open && <div className="grid gap-3 mt-3">{children}</div>}
    </section>
  );
}
