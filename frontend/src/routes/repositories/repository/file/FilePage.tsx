import { useEffect, useState } from 'react';
import {
  useNavigate,
  useLocation,
  useSearchParams,
  Link,
} from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Check,
  Loader2,
  Rocket,
} from 'lucide-react';
import { getRepoName } from '../../../../utils/repo';
import type { RootState, AppDispatch } from '../../../../store/store';
import { filesApi } from '../../../../store/features/files/filesSlice';
import { useSelector as useCompilerSelector } from 'react-redux';
import { listArtifacts } from '../../../../store/features/compiler/compilerSlice';
import { SyntaxHighlighter } from '../../../../components/SyntaxHighlighter';
import { seedDraft } from '../../../../store/features/deployments/deployDraftSlice';

interface CopyButtonProps {
  content: string;
  label: string;
}

function CopyButton({ content, label }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await window.navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Failed to copy - silently ignore
      void err;
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="btn btn-secondary btn-sm flex items-center gap-2"
      title={`Copy ${label}`}
    >
      {copied ? (
        <>
          <Check size={14} />
          Copied
        </>
      ) : (
        <>
          <Copy size={14} />
          Copy
        </>
      )}
    </button>
  );
}

interface CodeSectionProps {
  title: string;
  content: string;
  showCopy?: boolean;
  language?: string;
  showLineNumbers?: boolean;
}

function CodeSection({
  title,
  content,
  showCopy = false,
  language,
  showLineNumbers = false,
}: CodeSectionProps) {
  return (
    <div className="card-milky p-4 mb-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-lg font-semibold">{title}</h3>
        {showCopy && (
          <CopyButton content={content} label={title.toLowerCase()} />
        )}
      </div>
      <div className="relative">
        {language ? (
          <SyntaxHighlighter
            code={content}
            language={language}
            showLineNumbers={showLineNumbers}
          />
        ) : (
          <pre className="code-surface p-4 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap text-[var(--text)]">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

export default function FilePage() {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Extract both repo path and file path from the URL
  const pathMatch = location.pathname.match(
    /\/repositories\/(.+?)\/file\/(.+)$/
  );
  const urlRepoPath = pathMatch ? pathMatch[1] : '';
  const urlFilePath = pathMatch ? pathMatch[2] : '';

  // Decode the paths from the URL
  const decodedRepoPath = urlRepoPath ? decodeURIComponent(urlRepoPath) : '';
  const decodedFilePath = urlFilePath ? decodeURIComponent(urlFilePath) : '';

  // Extract framework ID and directory path from query parameters
  const frameworkId = searchParams.get('framework');
  const directoryPath = searchParams.get('path');
  const artifactPath = searchParams.get('artifact');
  const contractName = searchParams.get('contract');

  // Get file data from store
  const fileKey = `${decodedRepoPath}:${decodedFilePath}`;
  const fileData = useSelector(
    (state: RootState) => state.files.files[fileKey]
  );

  // Get artifact data for this file from compiler store
  const compilerData = useCompilerSelector(
    (state: RootState) => state.compiler.compilations[decodedRepoPath]
  );
  const frameworkData = frameworkId ? compilerData?.[frameworkId] : null;

  // Load artifacts if they're missing (happens when accessing FilePage directly)
  useEffect(() => {
    if (
      frameworkId &&
      (!frameworkData || frameworkData.artifacts === undefined)
    ) {
      dispatch(
        listArtifacts({ pathOrUrl: decodedRepoPath, pluginId: frameworkId })
      );
    }
  }, [dispatch, decodedRepoPath, frameworkId, frameworkData]);

  // Fetch file content
  useEffect(() => {
    if (!fileData?.content && !fileData?.loading) {
      const actions = filesApi.fetchFileContent(
        decodedRepoPath,
        decodedFilePath
      );
      actions.forEach((action) => dispatch(action));
    }
  }, [
    dispatch,
    decodedRepoPath,
    decodedFilePath,
    fileData?.content,
    fileData?.loading,
  ]);

  // Fetch artifact data (keyed by framework: the same file has a different
  // artifact per framework in multi-framework repos)
  useEffect(() => {
    if (
      frameworkId &&
      frameworkData?.artifacts &&
      artifactPath &&
      !fileData?.artifactData?.[`${frameworkId}:${artifactPath}`]
    ) {
      const artifact = frameworkData.artifacts.find(
        (art: {
          sourcePath: string;
          artifactPath: string;
          contractName: string;
        }) =>
          art.artifactPath === artifactPath && art.contractName === contractName
      );

      if (artifact) {
        const action = filesApi.fetchArtifactData(
          decodedRepoPath,
          artifact.artifactPath,
          frameworkId,
          decodedFilePath
        );
        dispatch(action);
      }
    }
  }, [
    dispatch,
    decodedRepoPath,
    decodedFilePath,
    frameworkId,
    artifactPath,
    contractName,
    fileData?.artifactData,
    frameworkData?.artifacts,
  ]);

  const backToRepoUrl = (() => {
    const params = new URLSearchParams();
    if (frameworkId) {
      params.set('framework', frameworkId);
    }
    if (directoryPath) {
      params.set('path', directoryPath);
    }
    const queryString = params.toString();
    return `/repositories/${urlRepoPath}${queryString ? `?${queryString}` : ''}`;
  })();

  const handleBackClick = () => {
    navigate(backToRepoUrl);
  };

  const fileLoading = fileData?.loading || false;
  const contentLoaded = !!fileData?.content?.content;
  const artifactsLoading =
    frameworkId && frameworkData && frameworkData.artifacts === undefined;
  const error = fileData?.error;
  const content = fileData?.content?.content;
  const artifactData = frameworkId
    ? fileData?.artifactData?.[`${frameworkId}:${artifactPath}`]
    : undefined;
  const selectedArtifact = frameworkData?.artifacts?.find(
    (artifact) =>
      artifact.artifactPath === artifactPath &&
      artifact.contractName === contractName
  );
  const hasUnlinkedLibraries = Boolean(
    artifactData?.creationCodeLinkReferences &&
    Object.keys(artifactData.creationCodeLinkReferences).length > 0
  );
  const deploy = () => {
    if (!frameworkId || !selectedArtifact) return;
    dispatch(
      seedDraft([
        {
          id: `${frameworkId}:${selectedArtifact.artifactPath}:${selectedArtifact.contractName}`,
          repoPathOrUrl: decodedRepoPath,
          frameworkId,
          artifactPath: selectedArtifact.artifactPath,
          contractName: selectedArtifact.contractName,
          sourcePath: selectedArtifact.sourcePath,
        },
      ])
    );
    navigate('/deploy');
  };

  // Only show main loading for file content - artifact data loads separately in the Contract Details card
  const isLoading = fileLoading || !contentLoaded;

  return (
    <div className="text-[var(--text)]">
      {/* Header: back button + clickable breadcrumb */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={handleBackClick}
          className="btn btn-secondary btn-icon"
          aria-label="Back to repository"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <Link to="/repositories">Repositories</Link>
              <ChevronRight size={13} className="breadcrumb-sep" />
              <Link to={backToRepoUrl}>{getRepoName(decodedRepoPath)}</Link>
              <ChevronRight size={13} className="breadcrumb-sep" />
              <span className="breadcrumb-current">
                {decodedFilePath.split('/').pop()}
              </span>
            </nav>
            {frameworkId && (
              <span className="pill pill-primary rounded-full px-2 py-1 lowercase">
                {frameworkId}
              </span>
            )}
          </div>
          <p className="mono-data text-muted mt-1 truncate">
            {decodedFilePath}
          </p>
        </div>
      </div>

      {/* Contract Details section - show immediately if we have a framework */}
      {frameworkId && (
        <div className="card-milky p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Contract Details</h3>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!artifactData || hasUnlinkedLibraries}
              title={
                hasUnlinkedLibraries
                  ? 'Requires library linking (planned for D5)'
                  : undefined
              }
              onClick={deploy}
            >
              <Rocket size={15} /> Deploy
            </button>
          </div>
          {hasUnlinkedLibraries && (
            <p className="text-xs text-warn mb-3">
              Requires library linking (planned for D5).
            </p>
          )}
          {artifactData ? (
            <div className="flex flex-wrap gap-6 text-xs">
              <div>
                <div className="text-xs opacity-70 mb-1">Solidity Version</div>
                <div className="font-mono">{artifactData.solidityVersion}</div>
              </div>
              <div>
                <div className="text-xs opacity-70 mb-1">Optimizer</div>
                <div className="font-mono">
                  {artifactData.optimizer
                    ? `${artifactData.optimizerRuns} runs`
                    : 'Disabled'}
                </div>
              </div>
              {artifactData.evmVersion && (
                <div>
                  <div className="text-xs opacity-70 mb-1">EVM Version</div>
                  <div className="font-mono">{artifactData.evmVersion}</div>
                </div>
              )}
              <div>
                <div className="text-xs opacity-70 mb-1">Via IR</div>
                <div className="font-mono">
                  {artifactData.viaIR ? 'Yes' : 'No'}
                </div>
              </div>
              <div>
                <div className="text-xs opacity-70 mb-1">Bytecode Hash</div>
                <div className="font-mono">{artifactData.bytecodeHash}</div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 py-4">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm opacity-70">
                {artifactsLoading
                  ? 'Loading artifacts...'
                  : 'Loading contract details...'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Loading state for file content */}
      {isLoading && (
        <div className="card-milky p-6">
          <div className="flex items-center justify-center gap-3">
            <Loader2 size={20} className="animate-spin" />
            <span>Loading source code...</span>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div className="card-milky p-6">
          <div className="text-center">
            <h3 className="text-lg font-medium mb-2 text-err">
              Error Loading File
            </h3>
            <p className="text-sm opacity-70">{error}</p>
          </div>
        </div>
      )}

      {/* Source code and other content sections */}
      {!isLoading && !error && content && (
        <div className="space-y-4">
          {/* Source code */}
          <CodeSection
            title="Source Code"
            content={content}
            language={decodedFilePath.endsWith('.sol') ? 'solidity' : undefined}
            showLineNumbers
          />

          {/* ABI */}
          {artifactData?.abi && (
            <CodeSection
              title="ABI"
              content={JSON.stringify(artifactData.abi, null, 2)}
              showCopy={true}
              language="json"
            />
          )}

          {/* Creation code */}
          {artifactData?.creationCode && artifactData.creationCode !== '0x' && (
            <CodeSection
              title="Creation Code"
              content={artifactData.creationCode}
              showCopy={true}
            />
          )}

          {/* Deployed bytecode */}
          {artifactData?.deployedBytecode &&
            artifactData.deployedBytecode !== '0x' && (
              <CodeSection
                title="Deployed Bytecode"
                content={artifactData.deployedBytecode}
                showCopy={true}
              />
            )}
        </div>
      )}
    </div>
  );
}
