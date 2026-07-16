import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { isAddress } from 'viem';
import type {
  ExternalResolution,
  PointerSuggestion,
  PointerSuggestionData,
  WorkflowSource,
} from '@ignite/api';
import { apiClient } from '../../../store/api/client';
import type { UnboundWorkflowSlot } from '../projection';
import { decodeUrlEncodingForDisplay } from '../../../utils/displayText';

export function suggestionResolution(stepId: string, path: string, chainId: number, suggestion: PointerSuggestion): ExternalResolution {
  const first = suggestion.sources[0];
  return {
    stepId,
    path,
    chainId,
    address: suggestion.address,
    source: 'suggestion',
    ...(first ? { via: first.kind === 'artifact' ? { kind: 'artifact', runId: first.runId } : { kind: 'plugin', pluginId: first.pluginId } } : {}),
  };
}

export function manualResolution(stepId: string, path: string, chainId: number, address: string): ExternalResolution | undefined {
  const trimmed = address.trim();
  if (!isAddress(trimmed)) return undefined;
  return { stepId, path, chainId, address: trimmed, source: 'manual' };
}

export default function UnboundSlotPicker({
  repoPathOrUrl,
  workflowName,
  slots,
  source,
  onConfirm,
}: {
  repoPathOrUrl: string;
  workflowName: string;
  slots: UnboundWorkflowSlot[];
  source: WorkflowSource;
  onConfirm: (resolution: ExternalResolution) => void;
}) {
  const [data, setData] = useState<PointerSuggestionData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState<Record<string, string>>({});
  const chainKey = slots.map((slot) => slot.chainId).join(',');

  useEffect(() => {
    let cancelled = false;
    const chainIds = chainKey.split(',').map(Number);
    setLoading(true);
    void apiClient.request('pointerSuggestions', {
      body: {
        workflow: { repoPathOrUrl, name: workflowName },
        sourceId: source.id,
        ...(source.artifactHash ? { expectedArtifactHash: source.artifactHash } : {}),
        contractName: source.contractName,
        chainIds,
      },
    }).then((response) => {
      if (cancelled) return;
      if ('data' in response) setData(response.data);
      else setError(response.message);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Suggestions could not be loaded');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [repoPathOrUrl, source.artifactHash, source.contractName, source.id, workflowName, chainKey]);

  return (
    <div className="card-milky p-4 grid gap-4">
      <div>
        <div className="font-medium">Resolve {slots[0]?.stepId && decodeUrlEncodingForDisplay(slots[0].stepId)} <span className="mono-data">{slots[0]?.path}</span></div>
        <div className="text-sm text-muted">The excluded {source.contractName} deployment needs a confirmed address on each chain.</div>
      </div>
      {loading && <div className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading pointer suggestions…</div>}
      {error && <div className="text-sm text-err">{decodeUrlEncodingForDisplay(error)}</div>}
      {slots.map((slot) => {
        const candidates = data?.suggestionsByChain[String(slot.chainId)] ?? [];
        const manualValue = manual[String(slot.chainId)] ?? '';
        return (
          <div key={slot.chainId} className="border-t border-[var(--border)] pt-3 grid gap-2">
            <div className="font-medium text-sm">Chain {slot.chainId}</div>
            {candidates.length === 0 && !loading && <div className="text-sm text-muted">No suggestions found. Enter an address manually.</div>}
            {candidates.map((candidate) => (
              <div key={`${candidate.address}-${candidate.match}`} className="flex items-center gap-2 text-sm">
                <span className="mono-data flex-1 truncate">{candidate.address}</span>
                <span className="pill rounded-full px-2 py-0.5">{candidate.sources[0]?.kind === 'artifact' ? `run ${candidate.sources[0].runId.slice(0, 7)}` : candidate.sources[0]?.kind === 'plugin' ? candidate.sources[0].label ?? candidate.sources[0].pluginId : 'history'}</span>
                <span className={`pill rounded-full px-2 py-0.5 ${candidate.match === 'artifact-hash' ? 'pill-success' : 'pill-warning'}`}>{candidate.match === 'artifact-hash' ? 'exact bytecode match' : 'name match'}</span>
                {candidate.versionLabel && <span className="pill rounded-full px-2 py-0.5">{candidate.versionLabel}</span>}
                <button type="button" className="btn btn-sm btn-primary" onClick={() => onConfirm(suggestionResolution(slot.stepId, slot.path, slot.chainId, candidate))}><Check size={13} /> Use</button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input className="input mono-data flex-1" aria-label={`Manual address for chain ${slot.chainId}`} placeholder="0x…" value={manualValue} onChange={(event) => setManual((current) => ({ ...current, [String(slot.chainId)]: event.target.value }))} />
              <button type="button" className="btn btn-sm btn-secondary" disabled={!manualResolution(slot.stepId, slot.path, slot.chainId, manualValue)} onClick={() => { const resolution = manualResolution(slot.stepId, slot.path, slot.chainId, manualValue); if (resolution) onConfirm(resolution); }}>Use manual</button>
            </div>
          </div>
        );
      })}
      {data?.truncated && <div className="text-sm text-warn">Suggestion scanning reached its safety limit; some older candidates may not be shown.</div>}
    </div>
  );
}
