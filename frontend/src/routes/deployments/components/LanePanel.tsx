import type { ChainInfo, Lane, ResolveAction, Step } from '@ignite/api';
import { Check, Circle, Copy, Loader2, X } from 'lucide-react';
import ChainIcon from '../../settings/tabs/chains/ChainIcon';
import PauseBanner from './PauseBanner';

function statusIcon(status: string) {
  if (status === 'confirmed' || status === 'completed')
    return <Check size={16} className="text-ok" />;
  if (status === 'failed' || status === 'aborted')
    return <X size={16} className="text-err" />;
  if (
    status === 'running' ||
    status === 'estimating' ||
    status === 'broadcasting' ||
    status === 'confirming' ||
    status === 'awaiting-signature'
  )
    return <Loader2 size={16} className="animate-spin text-info" />;
  return <Circle size={14} className="text-muted" />;
}

function CopyValue({ value }: { value: string }) {
  return (
    <button
      type="button"
      className="btn btn-sm btn-secondary-borderless mono-data"
      title={value}
      onClick={() => void globalThis.navigator.clipboard.writeText(value)}
    >
      {value.slice(0, 10)}…{value.slice(-6)} <Copy size={12} />
    </button>
  );
}

interface LanePanelProps {
  lane: Lane;
  chain?: ChainInfo;
  planSteps: Step[];
  contractNames: Record<string, string>;
  capability: 'sign-only' | 'sign-and-send';
  onAction: (action: ResolveAction) => void;
}

export default function LanePanel({
  lane,
  chain,
  planSteps,
  contractNames,
  capability,
  onAction,
}: LanePanelProps) {
  return (
    <section className="card-milky p-4 grid gap-4">
      <header className="flex items-center gap-3">
        {chain && <ChainIcon chain={chain} />}
        <div className="min-w-0">
          <h2 className="font-semibold">
            {chain?.name ?? `Chain ${lane.chainId}`}
          </h2>
          <span className="mono-data text-muted">{lane.chainId}</span>
        </div>
        <span
          className={`chip ml-auto ${lane.status === 'completed' ? 'chip-ok' : lane.status === 'paused' ? 'chip-warn' : ''}`}
        >
          <span className="chip-dot" />
          {lane.status}
        </span>
      </header>

      <div className="glass-list">
        {lane.steps.map((step, index) => {
          const planStep = planSteps.find((item) => item.id === step.stepId);
          const attempt = step.attempts.at(-1);
          return (
            <div key={step.stepId} className="list-row flex items-start gap-3">
              <span className="mt-0.5">{statusIcon(step.status)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {planStep ? contractNames[planStep.contractId] : step.stepId}
                </div>
                <div className="text-xs text-muted">{step.status}</div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  {attempt?.txHash && <CopyValue value={attempt.txHash} />}
                  {step.address && <CopyValue value={step.address} />}
                  {attempt?.gasUsed && (
                    <span className="mono-data text-muted">
                      {attempt.gasUsed} gas
                    </span>
                  )}
                </div>
              </div>
              <span className="mono-data text-muted">#{index + 1}</span>
            </div>
          );
        })}
      </div>

      <PauseBanner lane={lane} capability={capability} onAction={onAction} />
    </section>
  );
}
