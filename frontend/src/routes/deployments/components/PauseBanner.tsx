import { allowedActions } from '@ignite/api';
import type { Lane, PauseContext, ResolveAction } from '@ignite/api';
import { AlertTriangle } from 'lucide-react';

const ACTION_LABELS: Record<ResolveAction, string> = {
  retry: 'Retry',
  edit: 'Edit & retry',
  skip: 'Skip step',
  'abort-lane': 'Abort lane',
  recheck: 'Re-check receipt',
  'confirm-hash': 'Confirm transaction hash',
  'mark-not-sent': 'Mark not sent',
  replace: 'Replace transaction',
  'keep-waiting': 'Keep waiting',
};

interface PauseBannerProps {
  lane: Lane;
  capability: PauseContext['capability'];
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
  });
}

export default function PauseBanner({
  lane,
  capability,
  onAction,
}: PauseBannerProps) {
  if (!lane.pause) return null;
  const actions = actionsForPausedLane(lane, capability);
  return (
    <div className="card-milky p-4 border border-warn/30">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="text-warn mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Lane paused: {lane.pause.reason}</div>
          <p className="text-sm text-muted mt-1">{lane.pause.error}</p>
          <div className="flex flex-wrap gap-2 mt-3">
            {actions.map((action) => (
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
