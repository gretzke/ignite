import { allowedActions } from '@ignite/api';
import type { Lane, PauseContext, ResolveAction } from '@ignite/api';
import { AlertTriangle } from 'lucide-react';

export const ACTION_LABELS: Record<ResolveAction, string> = {
  retry: 'Retry',
  edit: 'Edit & retry',
  skip: 'Skip step',
  'abort-lane': 'Abort lane',
  recheck: 'Re-check receipt',
  'confirm-hash': 'Confirm transaction hash',
  'mark-not-sent': 'Mark not sent',
  replace: 'Replace transaction',
  'keep-waiting': 'Keep waiting',
  'accept-deployed': 'Accept existing deployment',
};

const PAUSE_COPY: Partial<Record<PauseContext['reason'], string>> = {
  'create2-collision': 'A contract already exists at the predicted address.',
  'created-code-missing': 'The transaction succeeded but no code appeared at the predicted address.',
  'pointer-unresolved': 'A referenced step has no deployed address.',
};

interface PauseBannerProps {
  lane: Lane;
  capability?: PauseContext['capability'];
  onAction: (action: ResolveAction) => void;
}

export function actionsForPausedLane(
  lane: Lane,
  capability: PauseContext['capability']
): ResolveAction[] {
  if (!lane.pause) return [];
  const attempt = lane.steps[lane.pause.stepIndex]?.attempts.find(
    (item) => item.id === lane.pause?.attemptId
  );
  return allowedActions({
    reason: lane.pause.reason,
    capability,
    submitted: Boolean(attempt?.txHash || attempt?.rawTx),
    hasIntent: Boolean(attempt?.expected),
  });
}

export default function PauseBanner({
  lane,
  capability,
  onAction,
}: PauseBannerProps) {
  if (!lane.pause) return null;
  if (!capability && lane.pause.reason === 'receipt-timeout') {
    return (
      <div className="card-milky p-4 border border-warn/30 text-sm text-muted">
        Loading signer capability before showing safe resolution actions…
      </div>
    );
  }
  // The banner IS the shared verb table — no post-filtering. A recheck
  // without a known hash is a harmless engine-side no-op, and hiding shared
  // verbs here would desynchronize the UI from the enforcement contract.
  const safeActions = actionsForPausedLane(lane, capability ?? 'sign-and-send');
  return (
    <div className="card-milky p-4 border border-warn/30">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-warn mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Lane paused: {lane.pause.reason}</div>
          <p className="text-sm text-muted mt-1">{PAUSE_COPY[lane.pause.reason] ?? lane.pause.error}</p>
          {PAUSE_COPY[lane.pause.reason] && lane.pause.error && (
            <p className="text-xs text-muted mt-1">{lane.pause.error}</p>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            {safeActions.map((action) => (
              <button
                key={action}
                type="button"
                className={
                  action === 'abort-lane'
                    ? 'btn btn-sm btn-danger'
                    : 'btn btn-sm btn-secondary'
                }
                onClick={() => onAction(action)}
              >
                {ACTION_LABELS[action]}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
