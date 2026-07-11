import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, Folder, FileCode, ChevronRight, Rocket, BadgeCheck } from 'lucide-react';
import {
  buildPathTree,
  getDirectoryContents,
  type DirectoryNode,
  type FileNode,
} from '../../../../utils/pathTree';
import type { ArtifactLocation } from '@ignite/api';
import { useAppDispatch } from '../../../../store';
import { seedDraft } from '../../../../store/features/deployments/deployDraftSlice';

interface ArtifactBrowserProps {
  artifacts: ArtifactLocation[];
  loading?: boolean;
  error?: string;
  frameworkId?: string;
}

export default function ArtifactBrowser({
  artifacts,
  loading = false,
  frameworkId,
}: ArtifactBrowserProps) {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { repoPath } = useParams<{ repoPath: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get current directory path from URL params, default to empty (root)
  const [currentPath, setCurrentPath] = useState<string>(
    searchParams.get('path') || ''
  );
  const [selected, setSelected] = useState<Record<string, ArtifactLocation>>(
    {}
  );

  // Sync currentPath with URL params when it changes
  useEffect(() => {
    const urlPath = searchParams.get('path') || '';
    if (urlPath !== currentPath) {
      setCurrentPath(urlPath);
    }
  }, [searchParams, currentPath]);

  // Build tree from artifacts (contracts only)
  const pathTree = useMemo(() => {
    if (!artifacts || artifacts.length === 0) {
      return null;
    }
    return buildPathTree(artifacts);
  }, [artifacts]);

  // Get current directory contents
  const directoryContents = useMemo(() => {
    if (!pathTree) return { directories: [], files: [] };
    return getDirectoryContents(pathTree, currentPath);
  }, [pathTree, currentPath]);

  const handleDirectoryClick = (directory: DirectoryNode) => {
    setCurrentPath(directory.path);
    // Update URL params to preserve directory context
    const newParams = new URLSearchParams(searchParams);
    if (directory.path) {
      newParams.set('path', directory.path);
    } else {
      newParams.delete('path');
    }
    setSearchParams(newParams);
  };

  const handleFileClick = (file: FileNode) => {
    // Navigate to file page using wildcard route
    // repoPath from useParams is decoded, so we need to encode it again
    const encodedRepoPath = encodeURIComponent(repoPath || '');
    const encodedFilePath = encodeURIComponent(file.path);

    // Build query parameters including framework and current directory path
    const params = new URLSearchParams();
    if (frameworkId) {
      params.set('framework', frameworkId);
    }
    if (currentPath) {
      params.set('path', currentPath);
    }
    params.set('artifact', file.artifact.artifactPath);
    params.set('contract', file.artifact.contractName);
    const queryString = params.toString();
    const queryParams = queryString ? `?${queryString}` : '';

    navigate(
      `/repositories/${encodedRepoPath}/file/${encodedFilePath}${queryParams}`
    );
  };
  const verifyArtifact = (artifact: ArtifactLocation) => {
    if (!frameworkId || !repoPath) return;
    const params = new URLSearchParams({
      contractId: `${frameworkId}:${artifact.artifactPath}:${artifact.contractName}`,
      repoPathOrUrl: repoPath,
      frameworkId,
      artifactPath: artifact.artifactPath,
      contractName: artifact.contractName,
      sourcePath: artifact.sourcePath,
    });
    navigate(`/verify?${params}`);
  };

  const handleBackClick = () => {
    if (currentPath === '') return;
    const pathParts = currentPath.split('/');
    pathParts.pop();
    const newPath = pathParts.join('/');
    setCurrentPath(newPath);

    // Update URL params to preserve directory context
    const newParams = new URLSearchParams(searchParams);
    if (newPath) {
      newParams.set('path', newPath);
    } else {
      newParams.delete('path');
    }
    setSearchParams(newParams);
  };

  // Loading state
  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Loading contracts...
        </div>
      </div>
    );
  }

  // Empty state
  if (!pathTree || !artifacts || artifacts.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="text-center">
          <div className="text-sm text-muted mb-2">No contracts found</div>
          <div className="text-xs text-muted">
            Compile your contracts to see them here
          </div>
        </div>
      </div>
    );
  }

  const currentPathDisplay = currentPath || 'root';
  const { directories, files } = directoryContents;
  const deploySelected = () => {
    if (!frameworkId || !repoPath) return;
    const contracts = Object.values(selected).map((artifact) => ({
      id: `${frameworkId}:${artifact.artifactPath}:${artifact.contractName}`,
      // react-router has already decoded the path parameter.
      repoPathOrUrl: repoPath,
      frameworkId,
      artifactPath: artifact.artifactPath,
      contractName: artifact.contractName,
      sourcePath: artifact.sourcePath,
    }));
    dispatch(seedDraft(contracts));
    navigate('/deploy');
  };

  return (
    <div>
      {/* Header with navigation */}
      <div className="mb-4 pb-3 border-b border-[var(--hairline)]">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 min-w-0">
            {currentPath && (
              <button
                onClick={handleBackClick}
                className="btn btn-secondary btn-secondary-borderless flex items-center justify-center"
                style={{ width: 28, height: 28, padding: 0 }}
                aria-label="Up one directory"
                title="Up one directory"
              >
                <ChevronRight size={16} className="rotate-180" />
              </button>
            )}
            <span className="mono-data text-muted truncate">
              {currentPathDisplay}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">
              {files.length} contract{files.length !== 1 ? 's' : ''}
            </span>
            {Object.keys(selected).length > 0 && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={deploySelected}
              >
                <Rocket size={14} /> Deploy selected (
                {Object.keys(selected).length})
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Directories and contracts: hairline-divided rows in one pane */}
      <div className="glass-list">
        {directories.map((directory) => (
          <button
            key={directory.path}
            onClick={() => handleDirectoryClick(directory)}
            className="list-row clickable flex items-center gap-3"
          >
            <Folder size={16} className="text-info flex-shrink-0" />
            <span className="text-sm text-[var(--text)]">{directory.name}</span>
            <ChevronRight
              size={14}
              className="text-muted ml-auto flex-shrink-0"
            />
          </button>
        ))}

        {files.map((file) => (
          <div
            key={file.identity}
            className="list-row clickable flex items-center gap-3"
          >
            <input
              type="checkbox"
              checked={Boolean(selected[file.identity])}
              aria-label={`Select ${file.artifact.contractName}`}
              onChange={(event) =>
                setSelected((current) => {
                  const next = { ...current };
                  if (event.target.checked) next[file.identity] = file.artifact;
                  else delete next[file.identity];
                  return next;
                })
              }
            />
            <FileCode size={16} className="text-ok flex-shrink-0" />
            <button
              type="button"
              onClick={() => handleFileClick(file)}
              className="flex-1 min-w-0 text-left"
            >
              <div className="text-sm text-[var(--text)] truncate">
                {file.artifact.contractName}
              </div>
              <div className="mono-data text-muted truncate">{file.name}</div>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => verifyArtifact(file.artifact)}
            >
              <BadgeCheck size={14} /> Verify
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
