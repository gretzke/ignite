import { EllipsisVertical, Pin, RotateCcw, Trash2 } from 'lucide-react';
import type { OrphanVersionGroup, RepoVersionSummary } from '@ignite/api';
import Dropdown from '../../../components/Dropdown';
import { FrameworkChips } from './RepoCard';
import Tooltip from '../../../components/Tooltip';
import {
  type IVersionAddJob,
  versionAddJobKey,
} from '../../../store/features/repositories/repositoriesSlice';

function VersionFrameworkStatus({
  version,
  job,
}: {
  version: RepoVersionSummary;
  job?: IVersionAddJob;
}) {
  const active = job?.status === 'active' || Boolean(version.activeJobId);
  if (job?.status === 'failed' || (version.lastError && !active)) {
    return (
      <Tooltip label={job?.error ?? version.lastError?.message ?? 'Adding this version failed'} placement="top">
        <span className="chip chip-err">Failed</span>
      </Tooltip>
    );
  }

  if (version.frameworks === undefined || version.frameworks.length === 0)
    return <FrameworkChips frameworks={active ? undefined : []} />;
  const compiled = version.frameworks.every(
    (framework) => framework.compiledAt
  );
  return (
    <>
      <FrameworkChips frameworks={version.frameworks} />
      <span
        className={
          compiled ? 'chip chip-ok' : active ? 'chip chip-info' : 'chip chip-warn'
        }
      >
        <span className={compiled || !active ? 'chip-dot' : 'chip-dot pulse'} />
        {compiled ? 'Compiled' : active ? 'Compiling' : 'Not compiled'}
      </span>
    </>
  );
}

export function VersionRows({
  url: _url,
  versions,
  versionAddJobs = {},
  onRemove,
  onRetry = () => undefined,
  onBrowse,
}: {
  url: string;
  versions: RepoVersionSummary[];
  versionAddJobs?: Record<string, IVersionAddJob>;
  onRemove: (url: string, version: RepoVersionSummary) => void;
  onRetry?: (url: string, version: RepoVersionSummary) => void;
  onBrowse?: (url: string, version: RepoVersionSummary) => void;
}) {
  return (
    <>
      {versions.map((version) => {
        const job = versionAddJobs[versionAddJobKey(version.url, version.commit)];
        const active = job?.status === 'active' || Boolean(version.activeJobId);
        const retryable = job?.status === 'failed' || Boolean(version.lastError && !active);
        return (
          <div
          key={version.commit}
          className={`list-row flex items-center gap-3 pl-10 ${onBrowse ? 'clickable cursor-pointer' : ''}`}
          onClick={() => onBrowse?.(version.url, version)}
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
            <VersionFrameworkStatus
              version={version}
              job={job}
            />
          </div>
          {retryable && (
            <Tooltip label="Retry adding this version" placement="top">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={(event) => {
                  event.stopPropagation();
                  onRetry(version.url, version);
                }}
              >
                <RotateCcw size={14} /> Retry
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(version.url, version);
            }}
          >
            <Trash2 size={14} /> Remove
          </button>
          </div>
        );
      })}
    </>
  );
}

export function OrphanVersionGroupCard({
  group,
  versionAddJobs,
  onAddVersion,
  onRemove,
  onRetry,
  onBrowse,
}: {
  group: OrphanVersionGroup;
  versionAddJobs?: Record<string, IVersionAddJob>;
  onAddVersion: (group: OrphanVersionGroup) => void;
  onRemove: (url: string, version: RepoVersionSummary) => void;
  onRetry?: (url: string, version: RepoVersionSummary) => void;
  onBrowse?: (url: string, version: RepoVersionSummary) => void;
}) {
  return (
    <div className="glass-list">
      <div className="list-row flex items-center gap-3">
        <Pin size={17} className="text-info shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="mono-data text-sm font-semibold truncate">
            {group.url}
          </div>
        </div>
        <Dropdown
          anchor="right"
          menuClassName="glass-overlay p-1 min-w-36"
          renderTrigger={({ ref, open, toggle, getReferenceProps }) => (
            <button
              ref={ref}
              type="button"
              className="btn btn-secondary btn-secondary-borderless"
              style={{ width: 40, height: 36, paddingLeft: 0, paddingRight: 0 }}
              onClick={toggle}
              aria-label="Repository version actions"
              aria-haspopup="menu"
              aria-expanded={open}
              {...getReferenceProps()}
            >
              <EllipsisVertical size={16} />
            </button>
          )}
        >
          {({ close }) => (
            <button
              type="button"
              className="btn btn-secondary btn-sm w-full justify-start"
              onClick={() => {
                onAddVersion(group);
                close();
              }}
            >
              Add version
            </button>
          )}
        </Dropdown>
      </div>
      <VersionRows
        url={group.url}
        versions={group.versions}
        versionAddJobs={versionAddJobs ?? {}}
        onRemove={onRemove}
        onRetry={onRetry ?? (() => undefined)}
        onBrowse={onBrowse}
      />
    </div>
  );
}
