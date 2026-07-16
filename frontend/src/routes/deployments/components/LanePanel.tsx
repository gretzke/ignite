import type { ChainInfo, Lane, ResolveAction, Step } from '@ignite/api';
import { Check, Circle, Copy, Loader2, X } from 'lucide-react';
import ChainIcon from '../../settings/tabs/chains/ChainIcon';
import PauseBanner from './PauseBanner';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';

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

export function simulationTierLabel(tier: 'simulateV1' | 'fork' | 'estimate' | undefined) {
  if (tier === 'simulateV1') return 'Simulated on-chain (eth_simulateV1)';
  if (tier === 'fork') return 'Simulated on local fork';
  if (tier === 'estimate') return 'Per-transaction estimates';
  return undefined;
}

interface LanePanelProps {
  lane: Lane;
  chain?: ChainInfo;
  planSteps: Step[];
  contractNames: Record<string, string>;
  pluginLabels?: Record<string, string>;
  simulationTier?: 'simulateV1' | 'fork' | 'estimate';
  capability?: 'sign-only' | 'sign-and-send';
  onAction: (action: ResolveAction) => void;
}

export default function LanePanel({
  lane,
  chain,
  planSteps,
  contractNames,
  pluginLabels,
  simulationTier,
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
        {simulationTierLabel(simulationTier) && (
          <span className="chip chip-info">{simulationTierLabel(simulationTier)}</span>
        )}
      </header>

      <div className="glass-list">
        {lane.steps.map((step, index) => {
          const planStep = planSteps.find((item) => item.id === step.stepId);
          const attempt = step.attempts.at(-1);
          const target = planStep?.kind === 'call'
            ? planStep.targetPerChain?.[String(lane.chainId)] ?? planStep.target
            : undefined;
          const targetAddress = target?.kind === 'address'
            ? target.address
            : target?.kind === 'step'
              ? lane.steps.find((candidate) => candidate.stepId === target.stepId)?.address ?? lane.steps.find((candidate) => candidate.stepId === target.stepId)?.predictedAddress
              : undefined;
          const strategy = planStep?.kind === 'deploy' ? planStep.strategy : undefined;
          const title = planStep?.kind === 'deploy'
            ? contractNames[planStep.contractId]
            : planStep?.signature ?? decodeUrlEncodingForDisplay(step.stepId);
          const kindLabel = planStep?.kind === 'call'
            ? 'call'
            : strategy?.kind === 'create2'
              ? 'create2'
              : strategy?.kind === 'plugin'
                ? pluginLabels?.[strategy.pluginId] ?? strategy.pluginId
                : 'create';
          const alreadyDeployed = step.status === 'skipped' && attempt?.resolution === 'accept-deployed';
          return (
            <div key={step.stepId} className="list-row flex items-start gap-3">
              <span className="mt-0.5">{statusIcon(step.status)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium flex flex-wrap items-center gap-2">
                  {title}<span className="chip text-xs">{kindLabel}</span>
                </div>
                {planStep?.kind === 'call' && targetAddress && <div className="mono-data text-xs text-muted truncate">{targetAddress}</div>}
                <div className="text-xs text-muted">{alreadyDeployed ? 'already deployed — skipped' : step.status}</div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  {attempt?.txHash && <CopyValue value={attempt.txHash} />}
                  {step.address && step.predictedAddress?.toLowerCase() === step.address.toLowerCase() ? <span className="mono-data text-muted">{step.address} (predicted ✓)</span> : step.address && <CopyValue value={step.address} />}
                  {!step.address && step.predictedAddress && <span className="mono-data text-muted">{step.predictedAddress} (predicted)</span>}
                  {attempt?.gasUsed && (
                    <span className="mono-data text-muted">
                      {attempt.gasUsed} gas
                    </span>
                  )}
                </div>
                {(attempt?.expected?.libraries || attempt?.expected?.pointers) && (
                  <details className="text-xs text-muted mt-2"><summary className="cursor-pointer">Resolved inputs</summary>
                    {Object.entries(attempt.expected.libraries ?? {}).map(([name, address]) => <div key={`library-${name}`} className="mono-data mt-1">Library {name}: {address}</div>)}
                    {Object.entries(attempt.expected.pointers ?? {}).map(([path, address]) => <div key={`pointer-${path}`} className="mono-data mt-1">Pointer {path}: {address}</div>)}
                  </details>
                )}
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
