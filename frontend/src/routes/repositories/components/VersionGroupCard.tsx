import { Loader2, Pin, Plus, Trash2 } from 'lucide-react';
import type { OrphanVersionGroup, RepoVersionSummary } from '@ignite/api';
import { FrameworkChips } from './RepoCard';

function VersionFrameworkStatus({ version }: { version: RepoVersionSummary }) {
  if (version.frameworks === undefined || version.frameworks.length === 0)
    return <FrameworkChips frameworks={version.frameworks} />;
  const compiled = version.frameworks.every(
    (framework) => framework.compiledAt
  );
  return (
    <>
      <FrameworkChips frameworks={version.frameworks} />
      <span className={compiled ? 'chip chip-ok' : 'chip chip-info'}>
        <span className={compiled ? 'chip-dot' : 'chip-dot pulse'} />
        {compiled ? 'Compiled' : 'Compiling'}
      </span>
    </>
  );
}

export function VersionRows({
  url,
  versions,
  activeJobId,
  onRemove,
}: {
  url: string;
  versions: RepoVersionSummary[];
  activeJobId?: string;
  onRemove: (url: string, version: RepoVersionSummary) => void;
}) {
  return (
    <>
      {versions.map((version) => (
        <div
          key={version.commit}
          className="list-row flex items-center gap-3 pl-10"
        >
          <Pin size={15} className="text-info shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">
              {version.refLabel ?? version.commit.slice(0, 12)}
            </div>
            <div className="mono-data text-muted">
              {version.commit.slice(0, 12)}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            <VersionFrameworkStatus version={version} />
          </div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => onRemove(url, version)}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>
      ))}
      {activeJobId && (
        <div className="list-row flex items-center gap-2 pl-10 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" /> Adding version…
        </div>
      )}
    </>
  );
}

export function OrphanVersionGroupCard({
  group,
  activeJobId,
  onAddVersion,
  onRemove,
}: {
  group: OrphanVersionGroup;
  activeJobId?: string;
  onAddVersion: (group: OrphanVersionGroup) => void;
  onRemove: (url: string, version: RepoVersionSummary) => void;
}) {
  return (
    <div className="glass-list">
      <div className="list-row flex items-center gap-3">
        <Pin size={17} className="text-info shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="mono-data text-sm font-semibold truncate">{group.url}</div>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onAddVersion(group)}
        >
          <Plus size={14} /> Add version
        </button>
      </div>
      <VersionRows
        url={group.url}
        versions={group.versions}
        activeJobId={activeJobId}
        onRemove={onRemove}
      />
    </div>
  );
}
