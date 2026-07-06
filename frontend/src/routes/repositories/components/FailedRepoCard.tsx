import { FolderX, RotateCcw, X } from 'lucide-react';
import Tooltip from '../../../components/Tooltip';

interface FailedRepoCardProps {
  path: string;
  onRetry: (path: string) => void;
  onRemove: (name: string, path: string) => void;
}

export default function FailedRepoCard({
  path,
  onRetry,
  onRemove,
}: FailedRepoCardProps) {
  const repoName = path.split('/').pop() || path;

  return (
    <div className="list-row" style={{ boxShadow: 'inset 2px 0 0 var(--err)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="icon-tile text-err"
            style={{
              background: 'color-mix(in oklch, var(--err) 12%, transparent)',
              borderColor: 'color-mix(in oklch, var(--err) 25%, transparent)',
            }}
          >
            <FolderX size={16} />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{repoName}</div>
            <div className="mono-data text-muted truncate">{path}</div>
            <div className="mt-1">
              <span className="chip chip-err">
                <span className="chip-dot" />
                Initialization failed
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Tooltip label="Retry Initialization" placement="top">
            <button
              type="button"
              className="btn btn-secondary btn-secondary-borderless"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Retry initialization"
              title="Retry"
              onClick={() => onRetry(path)}
            >
              <RotateCcw size={16} />
            </button>
          </Tooltip>
          <Tooltip label="Remove" placement="top">
            <button
              type="button"
              className="btn btn-secondary btn-secondary-borderless"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Remove repository"
              title="Remove"
              onClick={() => onRemove(repoName, path)}
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
