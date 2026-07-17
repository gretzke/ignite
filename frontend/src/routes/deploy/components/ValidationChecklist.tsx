import type { ChainChecklist, ChainInfo, ValidationItem } from '@ignite/api';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { replaceIdsForDisplay } from '../../../utils/displayText';

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
  stepLabels?: Record<string, string>;
  onAcknowledge?: (chainId: number, item: ValidationItem) => void;
  run?: { workflow?: ValidationItem; outputs?: ValidationItem };
  onAcceptArtifactDrift?: (
    drifts: Array<{ sourceId: string; expected: string; actual: string }>
  ) => void;
}

export function artifactDrifts(item: {
  code?: string;
  details?: Record<string, unknown>;
}): Array<{ sourceId: string; expected: string; actual: string }> {
  if (
    item.code !== 'WORKFLOW_ARTIFACT_DRIFT' ||
    !Array.isArray(item.details?.drifts)
  )
    return [];
  return item.details.drifts.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    return typeof value.sourceId === 'string' &&
      typeof value.expected === 'string' &&
      typeof value.actual === 'string'
      ? [
          {
            sourceId: value.sourceId,
            expected: value.expected,
            actual: value.actual,
          },
        ]
      : [];
  });
}

export function simulationTierLabel(tier: unknown): string | undefined {
  if (tier === 'simulateV1') return 'Simulated on-chain (eth_simulateV1)';
  if (tier === 'fork') return 'Simulated on local fork';
  if (tier === 'estimate') return 'Per-transaction estimates';
  return undefined;
}

function detailGas(
  details: Record<string, unknown> | undefined
): Array<[string, string]> {
  if (!details) return [];
  const gas = details.perStep ?? details.gas ?? details.gasByStep;
  if (!gas || typeof gas !== 'object') return [];
  return Object.entries(gas as Record<string, unknown>).flatMap(
    ([stepId, value]) =>
      typeof value === 'string' || typeof value === 'number'
        ? [[stepId, String(value)]]
        : value &&
            typeof value === 'object' &&
            typeof (value as { gasUsed?: unknown }).gasUsed === 'string'
          ? [[stepId, (value as { gasUsed: string }).gasUsed]]
          : []
  );
}

function simulationWarnings(
  details: Record<string, unknown> | undefined
): string[] {
  if (!details) return [];
  const explicit = Array.isArray(details.warnings)
    ? details.warnings.filter(
        (warning): warning is string => typeof warning === 'string'
      )
    : [];
  const perStep = details.perStep;
  const dependent =
    perStep && typeof perStep === 'object'
      ? Object.entries(perStep as Record<string, unknown>).flatMap(
          ([stepId, value]) =>
            value &&
            typeof value === 'object' &&
            (value as { reason?: unknown }).reason ===
              'SIMULATION_UNAVAILABLE_DEPENDENT'
              ? [
                  `SIMULATION_UNAVAILABLE_DEPENDENT: ${stepId} will resolve at execution`,
                ]
              : []
        )
      : [];
  return [...new Set([...explicit, ...dependent])].filter((warning) =>
    warning.includes('SIMULATION_UNAVAILABLE_DEPENDENT')
  );
}

export default function ValidationChecklist({
  chains,
  chainInfo,
  stepLabels = {},
  onAcknowledge,
  run,
  onAcceptArtifactDrift,
}: ValidationChecklistProps) {
  return (
    <div className="grid gap-3">
      {run && (run.workflow || run.outputs) && (
        <section className="card-milky p-4">
          <h3 className="font-semibold mb-3">Run</h3>
          <div className="glass-list">
            {(['workflow', 'outputs'] as const).map((key) => {
              const item = run[key];
              if (!item) return null;
              const failed = item.blocking && !item.ok;
              return (
                <div key={key} className="list-row flex items-start gap-3">
                  {failed ? (
                    <CircleAlert size={17} className="text-err mt-0.5" />
                  ) : item.ok ? (
                    <CheckCircle2 size={17} className="text-ok mt-0.5" />
                  ) : (
                    <CircleAlert size={17} className="text-warn mt-0.5" />
                  )}
                  <div>
                    <div className="text-sm font-medium capitalize">{key}</div>
                    <div className="text-xs text-muted">{item.message}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
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
                        {replaceIdsForDisplay(item.message, stepLabels)}
                      </div>
                      {key === 'simulation' && (
                        <span className="chip chip-info mt-2">
                          {simulationTierLabel(
                            item.details?.tier ?? item.details?.simulationTier
                          ) ?? replaceIdsForDisplay(item.message, stepLabels)}
                        </span>
                      )}
                      {detailGas(item.details).length > 0 && (
                        <details className="text-xs text-muted mt-2">
                          <summary className="cursor-pointer">
                            Per-step gas
                          </summary>
                          {detailGas(item.details).map(([stepId, gas]) => (
                            <div key={stepId} className="mono-data mt-1">
                              {replaceIdsForDisplay(stepId, stepLabels)}: {gas}{' '}
                              gas
                            </div>
                          ))}
                        </details>
                      )}
                      {key === 'simulation' &&
                        simulationWarnings(item.details).map((warning) => (
                          <div key={warning} className="text-xs text-warn mt-1">
                            {replaceIdsForDisplay(warning, stepLabels)}
                          </div>
                        ))}
                      {key === 'args' &&
                        Array.isArray(item.details?.contractTypeItems) && (
                          <div className="grid gap-1 mt-2 text-xs">
                            {(item.details!.contractTypeItems as unknown[]).map((entry, index) => {
                              if (!entry || typeof entry !== 'object') return null;
                              const contractTypeItem = entry as ValidationItem;
                              return <div key={`${contractTypeItem.code}-${index}`} className={contractTypeItem.blocking && !contractTypeItem.ok ? 'text-err' : contractTypeItem.ok ? 'text-muted' : 'text-warn'}>{contractTypeItem.details?.['plugin-declared'] === true && <span className="chip mr-1">plugin-declared</span>}{replaceIdsForDisplay(contractTypeItem.message, stepLabels)}</div>;
                            })}
                          </div>
                        )}
                    </div>
                    {!item.ok &&
                      (item.code === 'CREATE2_ALREADY_DEPLOYED' ||
                        item.code === 'CREATE2_ACK_STALE') &&
                      onAcknowledge && (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary shrink-0"
                          onClick={() => onAcknowledge(Number(chainId), item)}
                        >
                          {item.code === 'CREATE2_ACK_STALE'
                            ? 'Re-confirm already deployed'
                            : 'Mark as already deployed'}
                        </button>
                      )}
                    {!item.ok &&
                      item.code === 'WORKFLOW_ARTIFACT_DRIFT' &&
                      artifactDrifts(item).length > 0 &&
                      onAcceptArtifactDrift && (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary shrink-0"
                          onClick={() =>
                            onAcceptArtifactDrift(artifactDrifts(item))
                          }
                        >
                          Accept drifted bytecode
                        </button>
                      )}
                    {!item.ok && item.code === 'UNINITIALIZED_PROXY_ACK_REQUIRED' && onAcknowledge && (
                      <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => onAcknowledge(Number(chainId), item)}>Acknowledge risk</button>
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
