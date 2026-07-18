import { useEffect, useMemo, useState } from 'react';
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
  Plus,
  BadgeCheck,
} from 'lucide-react';
import { getRepoName } from '../../../../utils/repo';
import type { RootState, AppDispatch } from '../../../../store/store';
import { fileCacheKey, filesApi } from '../../../../store/features/files/filesSlice';
import { useSelector as useCompilerSelector } from 'react-redux';
import { compilerScopeKey, listArtifacts } from '../../../../store/features/compiler/compilerSlice';
import { SyntaxHighlighter } from '../../../../components/SyntaxHighlighter';
import Select from '../../../../components/Select';
import {
  addContracts,
  removeContract,
} from '../../../../store/features/deployments/deployDraftSlice';
import { contractSourceId } from '../../../../utils/contractSourceId';
import type { ArtifactLocation, ContractSourcePin } from '@ignite/api';

interface CopyButtonProps {
  content: string;
  label: string;
}

export function canDeploySelectedArtifact(
  selected: { artifactPath: string } | undefined,
  explicitArtifactPath: string | null,
  variantCount: number
): boolean {
  return Boolean(selected && (variantCount <= 1 || explicitArtifactPath));
}

export function artifactVariantsForFile(
  artifacts: ArtifactLocation[] | undefined,
  sourcePath: string,
  contractName: string | null
) {
  if (!contractName || !artifacts) return [];
  const seenPaths = new Set<string>();
  return artifacts
    .filter(
      (artifact) =>
        artifact.sourcePath === sourcePath &&
        artifact.contractName === contractName &&
        !seenPaths.has(artifact.artifactPath) &&
        seenPaths.add(artifact.artifactPath) !== undefined
    )
    .map((artifact) => {
      const base = artifact.artifactPath.split('/').pop() ?? '';
      const suffix = base
        .replace(/\.json$/, '')
        .slice(artifact.contractName.length)
        .replace(/^\./, '');
      return { artifact, label: suffix || 'default' };
    })
    .map((entry, _index, entries) => {
      const collides = entries.filter((other) => other.label === entry.label).length > 1;
      if (!collides) return entry;
      const dir = entry.artifact.artifactPath.split('/')[0] || 'out';
      return { ...entry, label: `${entry.label} (${dir})` };
    })
    .sort((a, b) =>
      a.label.startsWith('default')
        ? -1
        : b.label.startsWith('default')
          ? 1
          : a.label.localeCompare(b.label)
    );
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
  const [searchParams, setSearchParams] = useSearchParams();

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
  const versionCommit = searchParams.get('version') ?? undefined;
  const repositories = useSelector(
    (state: RootState) => state.repositories.repositories
  );
  const version = useSelector((_state: RootState) => {
    if (!versionCommit) return undefined;
    return [...(repositories?.local ?? []), ...(repositories?.cloned ?? []), ...(repositories?.session ? [repositories.session] : [])]
      .flatMap((entry) => entry.versions)
      .find((candidate) => candidate.url === decodedRepoPath && candidate.commit === versionCommit) ??
      repositories?.versionGroups.find((group) => group.url === decodedRepoPath)
        ?.versions.find((candidate) => candidate.commit === versionCommit);
  });
  const pin: ContractSourcePin | undefined = versionCommit && version
    ? {
        url: version.url,
        commit: versionCommit,
        ...(version.refLabel && (version.refKind === 'tag' || version.refKind === 'branch')
          ? { ref: version.refLabel, refKind: version.refKind }
          : {}),
      }
    : undefined;
  const compilerKey = compilerScopeKey(decodedRepoPath, pin);
  const invalidVersion = Boolean(versionCommit && repositories && !version);
  const versionPending = Boolean(versionCommit && repositories === null);

  // Get file data from store
  const fileKey = fileCacheKey(decodedRepoPath, decodedFilePath, pin);
  const fileData = useSelector(
    (state: RootState) => state.files.files[fileKey]
  );

  // Get artifact data for this file from compiler store
  const compilerData = useCompilerSelector(
    (state: RootState) => state.compiler.compilations[compilerKey]
  );
  const frameworkData = frameworkId ? compilerData?.[frameworkId] : null;
  const selectedArtifact = frameworkData?.artifacts?.find((artifact) =>
    artifactPath && artifact.artifactPath === artifactPath && artifact.contractName === contractName
  );
  const selectedArtifactPath = selectedArtifact?.artifactPath;

  // Multi-solc/profile builds emit several artifacts for the same contract
  // (UniversalRouter.json, UniversalRouter.0.8.17.json, …). Offer a version
  // picker whenever more than one exists; the variant name is whatever sits
  // between the contract name and .json, 'default' for the canonical file.
  const versionVariants = useMemo(() => {
    return artifactVariantsForFile(
      frameworkData?.artifacts,
      decodedFilePath,
      contractName
    );
  }, [contractName, decodedFilePath, frameworkData?.artifacts]);

  const selectArtifactVersion = (nextArtifactPath: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('artifact', nextArtifactPath);
    setSearchParams(next, { replace: true });
  };

  // Load artifacts if they're missing (happens when accessing FilePage directly)
  useEffect(() => {
    if (
      !invalidVersion &&
      frameworkId &&
      (!frameworkData || frameworkData.artifacts === undefined)
    ) {
      dispatch(
        listArtifacts({ pathOrUrl: decodedRepoPath, pluginId: frameworkId, ...(pin ? { pin } : {}), stateKey: compilerKey })
      );
    }
  }, [dispatch, decodedRepoPath, frameworkId, frameworkData, pin, compilerKey, invalidVersion]);

  // Fetch file content
  useEffect(() => {
    if (!invalidVersion && !versionPending && !fileData?.content && !fileData?.loading) {
      const actions = filesApi.fetchFileContent(
        decodedRepoPath,
        decodedFilePath,
        pin
      );
      actions.forEach((action) => dispatch(action));
    }
  }, [
    dispatch,
    decodedRepoPath,
    decodedFilePath,
    fileData?.content,
    fileData?.loading,
    invalidVersion,
    versionPending,
    pin,
  ]);

  // Fetch artifact data (keyed by framework: the same file has a different
  // artifact per framework in multi-framework repos)
  useEffect(() => {
    if (
      !invalidVersion &&
      frameworkId &&
      frameworkData?.artifacts &&
      selectedArtifactPath &&
      !fileData?.artifactData?.[`${frameworkId}:${selectedArtifactPath}`]
    ) {
      const action = filesApi.fetchArtifactData(
        decodedRepoPath,
        selectedArtifactPath,
        frameworkId,
        decodedFilePath,
        pin
      );
      dispatch(action);
    }
  }, [
    dispatch,
    decodedRepoPath,
    decodedFilePath,
    frameworkId,
    selectedArtifactPath,
    fileData?.artifactData,
    frameworkData?.artifacts,
    pin,
    invalidVersion,
  ]);

  const backToRepoUrl = (() => {
    const params = new URLSearchParams();
    if (frameworkId) {
      params.set('framework', frameworkId);
    }
    if (directoryPath) {
      params.set('path', directoryPath);
    }
    if (versionCommit) params.set('version', versionCommit);
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
    ? fileData?.artifactData?.[`${frameworkId}:${selectedArtifactPath}`]
    : undefined;
  const draftContracts = useSelector(
    (state: RootState) => state.deployDraft.contracts
  );
  const draftActive = draftContracts.length > 0;
  const selectedContractId =
    frameworkId && selectedArtifact
      ? contractSourceId({
          repoPathOrUrl: decodedRepoPath,
          frameworkId,
          artifactPath: selectedArtifact.artifactPath,
          contractName: selectedArtifact.contractName,
          sourcePath: selectedArtifact.sourcePath,
          ...(pin ? { pin } : {}),
        })
      : undefined;
  const inDraft = Boolean(
    selectedContractId && draftContracts.some((c) => c.id === selectedContractId)
  );
  const canDeploy = canDeploySelectedArtifact(
    selectedArtifact,
    artifactPath,
    versionVariants.length
  );
  const deploy = () => {
    if (!frameworkId || !selectedArtifact || !selectedContractId || !canDeploy) return;
    if (inDraft) {
      dispatch(removeContract(selectedContractId));
      return;
    }
    const wasEmpty = !draftActive;
    dispatch(
      addContracts([
        {
          id: selectedContractId,
          repoPathOrUrl: decodedRepoPath,
          frameworkId,
          artifactPath: selectedArtifact.artifactPath,
          contractName: selectedArtifact.contractName,
          sourcePath: selectedArtifact.sourcePath,
          ...(pin ? { pin } : {}),
        },
      ])
    );
    if (wasEmpty) navigate('/deploy');
  };
  const verify = () => {
    if (!frameworkId || !selectedArtifact) return;
    const params = new URLSearchParams({
      contractId: contractSourceId({
        repoPathOrUrl: decodedRepoPath,
        frameworkId,
        artifactPath: selectedArtifact.artifactPath,
        contractName: selectedArtifact.contractName,
        sourcePath: selectedArtifact.sourcePath,
        ...(pin ? { pin } : {}),
      }),
      repoPathOrUrl: decodedRepoPath,
      frameworkId,
      artifactPath: selectedArtifact.artifactPath,
      contractName: selectedArtifact.contractName,
      sourcePath: selectedArtifact.sourcePath,
    });
    if (pin) {
      params.set('pinUrl', pin.url);
      params.set('pinCommit', pin.commit);
      if (pin.ref) params.set('pinRef', pin.ref);
      if (pin.refKind) params.set('pinRefKind', pin.refKind);
    }
    navigate(`/verify?${params}`);
  };

  // Only show main loading for file content - artifact data loads separately in the Contract Details card
  const isLoading = fileLoading || !contentLoaded;

  if (invalidVersion) {
    return (
      <div className="text-[var(--text)]">
        <button onClick={() => navigate('/repositories')} className="btn btn-secondary btn-icon" aria-label="Back to repositories"><ArrowLeft size={18} /></button>
        <div className="card-milky p-6 mt-6"><h2 className="text-lg font-semibold">Version Not Installed</h2><p className="text-sm text-muted mt-2">This version is not installed for this repository.</p></div>
      </div>
    );
  }

  if (versionPending) {
    return <div className="card-milky p-6 flex items-center gap-3"><Loader2 size={20} className="animate-spin" /><span>Loading repository version...</span></div>;
  }

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
            {pin && <span className="chip chip-info">{version?.refLabel ?? pin.commit.slice(0, 12)} · {pin.commit.slice(0, 12)}</span>}
          </div>
          <p className="mono-data text-muted mt-1 truncate">
            {decodedFilePath}
          </p>
        </div>
      </div>

      {/* Contract Details section - show immediately if we have a framework */}
      {frameworkId && (
        <div className="card-milky p-4 mb-6">
          <div className="flex items-center justify-between mb-3 gap-3">
            <h3 className="text-lg font-semibold">Contract Details</h3>
            <div className="flex items-center gap-2">
              {versionVariants.length > 1 && (
                <Select
                  options={versionVariants.map(({ artifact, label }) => ({
                    value: artifact.artifactPath,
                    label: `Build: ${label}`,
                  }))}
                  value={selectedArtifactPath}
                  onValueChange={selectArtifactVersion}
                />
              )}
              <button
                type="button"
                className={inDraft ? 'btn btn-secondary' : 'btn btn-primary'}
                // Deployability gates adding; removal must stay possible even
                // when the artifact no longer loads or needs linking.
                disabled={!inDraft && (!artifactData || !canDeploy)}
                title={inDraft ? 'Remove from deployment' : undefined}
                onClick={deploy}
              >
                {inDraft ? (
                  <>
                    <Check size={15} /> Added
                  </>
                ) : draftActive ? (
                  <>
                    <Plus size={15} /> Add to deployment
                  </>
                ) : (
                  <>
                    <Rocket size={15} /> Deploy
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!artifactData}
                onClick={verify}
              >
                <BadgeCheck size={15} /> Verify
              </button>
            </div>
          </div>
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
