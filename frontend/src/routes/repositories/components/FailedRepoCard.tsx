import { RotateCcw, X } from 'lucide-react';
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
    <div className="card-milky p-4 border-l-4 border-red-500">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-8 rounded-[var(--radius)] border border-red-500/20 bg-red-500/10 backdrop-blur-sm flex items-center justify-center text-sm">
            ❌
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate text-red-500">
              {repoName}
            </div>
            <div className="text-xs opacity-70 truncate">{path}</div>
            <div className="text-xs text-red-500">Initialization failed</div>
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
