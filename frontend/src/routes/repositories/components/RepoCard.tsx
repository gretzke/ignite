import { useNavigate } from 'react-router-dom';
import Tooltip from '../../../components/Tooltip';
import Dropdown from '../../../components/Dropdown';
import {
  Bookmark,
  X,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitPullRequest,
  FileEdit,
  EllipsisVertical,
  RotateCcw,
} from 'lucide-react';
import { useAppSelector } from '../../../store/hooks';
import {
  selectRepositoriesData,
  type IFramework,
  type IRepository,
} from '../../../store/features/repositories/repositoriesSlice';

// Helper to get repository initialization status
export function getRepoInitStatus(
  path: string,
  repositoriesData: Record<string, IRepository>
) {
  const repoData = repositoriesData[path];
  if (!repoData) return 'unknown';
  if (repoData.initialized === undefined) return 'loading';
  if (repoData.initialized === true) return 'success';
  if (repoData.initialized === false) return 'error';
  return 'unknown';
}

// Helper to determine if pull button should be shown
export function shouldShowPullButton(
  path: string,
  repositoriesData: Record<string, IRepository>
) {
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Only show for successfully initialized repos
  if (status !== 'success' || !repoData?.info) {
    return false;
  }

  // Show if repo has changes (dirty) or is not up to date
  return !repoData.info.upToDate;
}

// Helper to determine if repo card should be clickable
function isRepoClickable(
  path: string,
  repositoriesData: Record<string, IRepository>
) {
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Only clickable if successfully initialized and has frameworks
  return (
    status === 'success' &&
    repoData?.frameworks &&
    repoData.frameworks.length > 0
  );
}

// Status indicator component
function StatusIndicator({ path }: { path: string }) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const lifecycleError = repoData?.lastError;
  const status = getRepoInitStatus(path, repositoriesData);

  if (repoData?.compiling) {
    return <span className="chip chip-info"><span className="chip-dot pulse" /> Compiling</span>;
  }

  if (lifecycleError) {
    return <span className="chip chip-err"><span className="chip-dot" /> Failed</span>;
  }

  switch (status) {
    case 'loading':
      return (
        <span className="chip chip-info">
          <span className="chip-dot pulse" />
          Initializing
        </span>
      );
    case 'success':
      return (
        <span className="chip chip-ok">
          <span className="chip-dot" />
          Ready
        </span>
      );
    case 'error':
      return (
        <span className="chip chip-err">
          <span className="chip-dot" />
          Failed
        </span>
      );
    default:
      return null;
  }
}

// Dirty indicator component
function DirtyIndicator({
  path,
  onResetRepo,
}: {
  path: string;
  onResetRepo: (path: string) => void;
}) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  if (status !== 'success' || !repoData?.info) {
    return null;
  }

  // Only show if repo is dirty
  if (!repoData.info.dirty) {
    return null;
  }

  return (
    <Tooltip
      label="Uncommitted changes present — click to discard them"
      placement="top"
    >
      <div
        className="row-action flex items-center gap-1 cursor-pointer text-warn hover:opacity-80 transition-opacity"
        role="button"
        tabIndex={0}
        aria-label="Discard uncommitted changes"
        onClick={() => {
          onResetRepo(path);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onResetRepo(path);
          }
        }}
      >
        <FileEdit size={12} />
        <span className="mono-data">dirty</span>
      </div>
    </Tooltip>
  );
}

// Branch selector component with custom trigger
function BranchSelector({
  path,
  onOpenVersion,
}: {
  path: string;
  onOpenVersion?: (path: string, initial?: VersionModalInitialValue) => void;
}) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Don't show branch selector if not successfully initialized
  if (status !== 'success' || !repoData) {
    return null;
  }

  const currentBranch = repoData.info?.branch;
  if (!currentBranch) {
    return null;
  }

  return (
    <button
      type="button"
      className="row-action flex items-center gap-1 cursor-pointer text-muted hover:text-accent transition-colors"
      onClick={() => onOpenVersion?.(path, { initialBranch: currentBranch })}
      title="Add version from branch"
      aria-label={`Add version from branch: ${currentBranch}`}
    >
      <GitBranch size={12} />
      <span className="mono-data">{currentBranch}</span>
    </button>
  );
}

// Commit hash selector component
function CommitHashSelector({
  path,
  onOpenVersion,
}: {
  path: string;
  onOpenVersion?: (path: string, initial?: VersionModalInitialValue) => void;
}) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Don't show commit hash selector if not successfully initialized
  if (status !== 'success' || !repoData) {
    return null;
  }

  const currentCommit = repoData.info?.commit;
  // Display short hash (first 7 characters) or 'commit' as fallback
  const displayHash = currentCommit ? currentCommit.substring(0, 7) : 'commit';

  const handleCommitHashClick = () =>
    onOpenVersion?.(path, { initialCommit: currentCommit });

  return (
    <button
      type="button"
      className="row-action flex items-center gap-1 cursor-pointer text-muted hover:text-accent transition-colors"
      onClick={() => {
        handleCommitHashClick();
      }}
      title="Add version from commit"
      aria-label={`Add version from commit: ${displayHash}`}
    >
      <GitCommit size={12} />
      <span className="mono-data">{displayHash}</span>
    </button>
  );
}

type VersionModalInitialValue = {
  initialBranch?: string;
  initialCommit?: string;
};

function VersionOverflowMenu({ onAddVersion }: { onAddVersion: () => void }) {
  return (
    <Dropdown
      anchor="right"
      menuClassName="glass-overlay p-1 min-w-36"
      renderTrigger={({ ref, open, toggle, getReferenceProps }) => (
        <Tooltip label="Repository actions" placement="top">
          <button
            ref={ref}
            type="button"
            className="row-action btn btn-secondary btn-secondary-borderless"
            style={{ width: 40, height: 36, paddingLeft: 0, paddingRight: 0 }}
            onClick={toggle}
            aria-label="Repository actions"
            aria-haspopup="menu"
            aria-expanded={open}
            {...getReferenceProps()}
          >
            <EllipsisVertical size={16} />
          </button>
        </Tooltip>
      )}
    >
      {({ close }) => (
        <button
          type="button"
          className="btn btn-secondary btn-sm w-full justify-start"
          onClick={() => {
            onAddVersion();
            close();
          }}
        >
          Add version
        </button>
      )}
    </Dropdown>
  );
}

// Framework badges component
export function FrameworkChips({ frameworks }: { frameworks?: IFramework[] }) {
  if (frameworks === undefined) {
    // Detection in progress
    return (
      <span className="chip chip-info">
        <span className="chip-dot pulse" />
        Detecting
      </span>
    );
  }

  if (frameworks.length === 0) {
    // No frameworks detected
    return (
      <span className="rounded-full pill px-2 py-0.5 lowercase">
        unknown framework
      </span>
    );
  }

  // Show framework badges
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {frameworks.map((framework) => (
        <span
          key={framework.id}
          className="pill rounded-full pill-primary px-2 py-0.5 lowercase"
        >
          {framework.name}
        </span>
      ))}
    </div>
  );
}

// Framework badges component
function FrameworkBadges({ path }: { path: string }) {
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const repoData = repositoriesData[path];
  const status = getRepoInitStatus(path, repositoriesData);

  // Only show framework information if repo is successfully initialized
  if (status !== 'success') return null;

  if (repoData?.compiling) return null;

  if (repoData?.lastError) return null;

  return <FrameworkChips frameworks={repoData?.frameworks} />;
}

export interface RepoCardProps {
  repo: {
    name: string;
    path: string;
    frameworks?: IFramework[];
    saved?: boolean;
    originUrl?: string;
  };
  variant: 'current' | 'local' | 'cloned';
  onSave?: () => void;
  onRemove?: (name: string, path: string) => void;
  onPull?: (path: string) => void;
  showPullButton: boolean;
  onResetRepo: (path: string) => void;
  onRetry?: (path: string) => void;
  onAddVersion?: (path: string, initial?: VersionModalInitialValue) => void;
}

// Consolidated RepoCard component
export default function RepoCard({
  repo,
  variant,
  onSave,
  onRemove,
  onPull,
  showPullButton,
  onResetRepo,
  onRetry,
  onAddVersion,
}: RepoCardProps) {
  const navigate = useNavigate();
  const repositoriesData = useAppSelector(selectRepositoriesData);
  const clickable = isRepoClickable(repo.path, repositoriesData);

  // Handler for repo card clicks
  const handleRepoClick = (path: string) => {
    if (isRepoClickable(path, repositoriesData)) {
      // Navigate to repo detail page - encode the path for URL safety
      const encodedPath = encodeURIComponent(path);
      navigate(`/repositories/${encodedPath}`);
    }
  };

  const CardContent = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="icon-tile">
          <FolderGit2 size={16} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{repo.name}</div>
          <div className="mono-data text-muted truncate">
            {repo.path}{' '}
            {variant === 'current' && repo.saved === false ? '(unsaved)' : ''}
          </div>
          <div className="flex items-center gap-3 mt-1">
            <StatusIndicator path={repo.path} />
            <BranchSelector path={repo.path} onOpenVersion={onAddVersion} />
            <CommitHashSelector path={repo.path} onOpenVersion={onAddVersion} />
            <DirtyIndicator path={repo.path} onResetRepo={onResetRepo} />
          </div>
        </div>
        <div className="ml-2 shrink-0">
          <FrameworkBadges path={repo.path} />
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {repositoriesData[repo.path]?.lastError && !repositoriesData[repo.path]?.compiling && onRetry && (
          <Tooltip label={repositoriesData[repo.path].lastError?.message ?? 'Retry lifecycle'} placement="top">
            <button type="button" className="btn btn-secondary btn-sm row-action" onClick={() => onRetry(repo.path)}>
              <RotateCcw size={14} /> Retry
            </button>
          </Tooltip>
        )}
        {showPullButton && onPull && (
          <Tooltip label="Pull Changes" placement="top">
            <button
              type="button"
              className={`row-action btn btn-secondary ${
                variant !== 'current' ? 'btn-secondary-borderless' : ''
              }`}
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Pull changes"
              title="Pull Changes"
              onClick={() => {
                onPull(repo.path);
              }}
            >
              <GitPullRequest size={16} />
            </button>
          </Tooltip>
        )}
        {variant === 'current' && repo.saved === false && onSave && (
          <Tooltip label="Save" placement="top">
            <button
              type="button"
              className="row-action btn btn-primary"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Save repository"
              title="Save"
              onClick={() => {
                onSave();
              }}
            >
              <Bookmark size={16} />
            </button>
          </Tooltip>
        )}
        {(variant === 'local' || variant === 'cloned') && onRemove && (
          <Tooltip label="Remove" placement="top">
            <button
              type="button"
              className="row-action btn btn-secondary btn-secondary-borderless"
              style={{
                width: 40,
                height: 36,
                paddingLeft: 0,
                paddingRight: 0,
              }}
              aria-label="Remove repository"
              title="Remove"
              onClick={() => {
                onRemove(repo.name, repo.path);
              }}
            >
              <X size={16} />
            </button>
          </Tooltip>
        )}
        {onAddVersion && (
          <VersionOverflowMenu onAddVersion={() => onAddVersion(repo.path)} />
        )}
      </div>
    </div>
  );

  // Current workspace reads as its own card; local/cloned entries render as
  // hairline-divided rows inside the section's glass-list container.
  const shellClass =
    variant === 'current' ? 'glass-card p-4 w-full text-left' : 'list-row';

  // The shell is always a <div>: the card holds real <button> controls
  // (pull/save/remove), and wrapping them in a shell <button> is invalid
  // HTML. Body clicks navigate via the stretched .row-overlay sibling;
  // controls sit above it with .row-action.
  return (
    <div className={`${shellClass}${clickable ? ' clickable relative' : ''}`}>
      {clickable && (
        <button
          type="button"
          className="row-overlay"
          onClick={() => handleRepoClick(repo.path)}
          aria-label={`Open ${repo.name} repository details`}
        />
      )}
      {CardContent}
    </div>
  );
}
