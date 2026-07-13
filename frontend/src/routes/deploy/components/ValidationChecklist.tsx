import type { ChainChecklist, ChainInfo, ValidationItem } from '@ignite/api';
import { CheckCircle2, CircleAlert } from 'lucide-react';

const ITEM_KEYS = [
  'rpc',
  'signers',
  'args',
  'estimation',
  'balance',
  'inputs',
  'verification',
  'create2',
  'simulation',
] as const;

interface ValidationChecklistProps {
  chains: Record<string, ChainChecklist>;
  chainInfo: ChainInfo[];
  onAcknowledge?: (chainId: number, item: ValidationItem) => void;
}

export function simulationTierLabel(tier: unknown): string | undefined {
  if (tier === 'simulateV1') return 'Simulated on-chain (eth_simulateV1)';
  if (tier === 'fork') return 'Simulated on local fork';
  if (tier === 'estimate') return 'Per-transaction estimates';
  return undefined;
}

function detailGas(details: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!details) return [];
  const gas = details.perStep ?? details.gas ?? details.gasByStep;
  if (!gas || typeof gas !== 'object') return [];
  return Object.entries(gas as Record<string, unknown>).flatMap(([stepId, value]) =>
    typeof value === 'string' || typeof value === 'number'
      ? [[stepId, String(value)]]
      : value && typeof value === 'object' && typeof (value as { gasUsed?: unknown }).gasUsed === 'string'
        ? [[stepId, (value as { gasUsed: string }).gasUsed]]
        : []
  );
}

function simulationWarnings(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const explicit = Array.isArray(details.warnings)
    ? details.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const perStep = details.perStep;
  const dependent = perStep && typeof perStep === 'object'
    ? Object.entries(perStep as Record<string, unknown>).flatMap(([stepId, value]) =>
        value && typeof value === 'object' && (value as { reason?: unknown }).reason === 'SIMULATION_UNAVAILABLE_DEPENDENT'
          ? [`SIMULATION_UNAVAILABLE_DEPENDENT: ${stepId} will resolve at execution`]
          : [])
    : [];
  return [...new Set([...explicit, ...dependent])].filter((warning) =>
    warning.includes('SIMULATION_UNAVAILABLE_DEPENDENT')
  );
}

export default function ValidationChecklist({
  chains,
  chainInfo,
  onAcknowledge,
}: ValidationChecklistProps) {
  return (
    <div className="grid gap-3">
      {Object.entries(chains).map(([chainId, checklist]) => {
        const chain = chainInfo.find(
          (item) => String(item.chainId) === chainId
        );
        return (
          <section key={chainId} className="card-milky p-4">
            <h3 className="font-semibold mb-3">
              {chain?.name ?? `Chain ${chainId}`}
            </h3>
            <div className="glass-list">
              {ITEM_KEYS.map((key) => {
                const item = checklist[key];
                if (!item) return null;
                const failed = item.blocking && !item.ok;
                const warning = !item.blocking && !item.ok;
                return (
                  <div key={key} className="list-row flex items-start gap-3">
                    {failed ? (
                      <CircleAlert size={17} className="text-err mt-0.5" />
                    ) : warning ? (
                      <CircleAlert size={17} className="text-warn mt-0.5" />
                    ) : (
                      <CheckCircle2
                        size={17}
                        className={
                          item.ok ? 'text-ok mt-0.5' : 'text-warn mt-0.5'
                        }
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium capitalize">
                        {key}
                      </div>
                      <div
                        className="text-xs text-muted"
                        style={{ overflowWrap: 'anywhere' }}
                      >
                        {item.message}
                      </div>
                      {key === 'simulation' && (
                        <span className="chip chip-info mt-2">
                          {simulationTierLabel(item.details?.tier ?? item.details?.simulationTier) ?? item.message}
                        </span>
                      )}
                      {detailGas(item.details).length > 0 && (
                        <details className="text-xs text-muted mt-2">
                          <summary className="cursor-pointer">Per-step gas</summary>
                          {detailGas(item.details).map(([stepId, gas]) => (
                            <div key={stepId} className="mono-data mt-1">{stepId}: {gas} gas</div>
                          ))}
                        </details>
                      )}
                      {key === 'simulation' && simulationWarnings(item.details).map((warning) => (
                        <div key={warning} className="text-xs text-warn mt-1">{warning}</div>
                      ))}
                    </div>
                    {!item.ok && (item.code === 'CREATE2_ALREADY_DEPLOYED' || item.code === 'CREATE2_ACK_STALE') && onAcknowledge && (
                      <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => onAcknowledge(Number(chainId), item)}>
                        {item.code === 'CREATE2_ACK_STALE' ? 'Re-confirm already deployed' : 'Mark as already deployed'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
