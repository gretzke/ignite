import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, Folder, FileCode, ChevronRight } from 'lucide-react';
import {
  buildPathTree,
  getDirectoryContents,
  type DirectoryNode,
  type FileNode,
} from '../../../../utils/pathTree';
import type { ArtifactLocation } from '@ignite/api';

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
  const { repoPath } = useParams<{ repoPath: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Get current directory path from URL params, default to empty (root)
  const [currentPath, setCurrentPath] = useState<string>(
    searchParams.get('path') || ''
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
    const queryString = params.toString();
    const queryParams = queryString ? `?${queryString}` : '';

    navigate(
      `/repositories/${encodedRepoPath}/file/${encodedFilePath}${queryParams}`
    );
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
          <span className="text-xs text-muted">
            {files.length} contract{files.length !== 1 ? 's' : ''}
          </span>
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
            <span className="text-sm text-[var(--text)]">
              {directory.name}
            </span>
            <ChevronRight
              size={14}
              className="text-muted ml-auto flex-shrink-0"
            />
          </button>
        ))}

        {files.map((file) => (
          <button
            key={file.path}
            onClick={() => handleFileClick(file)}
            className="list-row clickable flex items-center gap-3"
          >
            <FileCode size={16} className="text-ok flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-[var(--text)] truncate">
                {file.artifact.contractName}
              </div>
              <div className="mono-data text-muted truncate">{file.name}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
