import { Pin, Trash2 } from 'lucide-react';
import type { PinnedSummary } from '@ignite/api';

export default function PinnedRepoCard({
  pinned,
  onRemove,
}: {
  pinned: PinnedSummary;
  onRemove: (pinned: PinnedSummary) => void;
}) {
  const label = pinned.refLabel ?? pinned.commit.slice(0, 7);
  return (
    <div className="list-row flex items-center gap-3">
      <Pin size={17} className="text-info shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="mono-data truncate">
          {pinned.url}@{label}
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-1">
          <span className="pill rounded-full px-2 py-0.5 mono-data">
            {pinned.commit.slice(0, 7)}
          </span>
          {(pinned.frameworks ?? []).map((framework) => (
            <span
              key={framework.id}
              className="pill pill-primary rounded-full px-2 py-0.5"
            >
              {framework.name}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        aria-label={`Remove pinned ${pinned.url}`}
        onClick={() => onRemove(pinned)}
      >
        <Trash2 size={14} /> Remove
      </button>
    </div>
  );
}
