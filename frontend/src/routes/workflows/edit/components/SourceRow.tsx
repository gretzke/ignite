import { useMemo, useState } from 'react';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import type {
  ArtifactLocation,
  RepoWorkflowSource,
  WorkflowDocument,
  WorkflowStatusEntry,
} from '@ignite/api';
import {
  canonicalGitUrl,
  changeSourceVersion,
  sanitizeDisplayText,
} from '@ignite/api';
import AddVersionModal from '../../../repositories/components/AddVersionModal';
import { listArtifacts } from '../../../../store/features/compiler/compilerSlice';
import { useAppDispatch, useAppSelector } from '../../../../store/hooks';
import type { PluginRow } from '../../../../store/features/plugins/pluginsSlice';
import DeployConfigPanel from './DeployConfigPanel';

export default function SourceRow({
  source,
  document,
  status,
  plugins,
  highlighted,
  onChange,
  onRemove,
  onStrategyValidityChange,
}: {
  source: RepoWorkflowSource;
  document: WorkflowDocument;
  status?: WorkflowStatusEntry;
  plugins: PluginRow[];
  highlighted?: boolean;
  onChange: (document: WorkflowDocument) => void;
  onRemove: () => void;
  onStrategyValidityChange?: (valid: boolean) => void;
}) {
  const dispatch = useAppDispatch();
  const [pickVersion, setPickVersion] = useState(false);
  const [pickArtifact, setPickArtifact] = useState(false);
  const stateKey = `workflow-artifacts:${source.id}`;
  const artifactsState = useAppSelector(
    (state) => state.compiler.compilations[stateKey]?.[source.frameworkId]
  );
  const sourceStatus = status?.sources?.find((item) => item.id === source.id);
  const artifactFailure =
    status?.attempt?.status === 'failed' ||
    status?.attempt?.status === 'interrupted'
      ? status.attempt.failedSources?.find(
          (item) => item.id === source.id && item.code === 'ARTIFACT_NOT_FOUND'
        )
      : undefined;
  const pin = source.repo;
  const loadArtifacts = () =>
    dispatch(
      listArtifacts({
        pathOrUrl: pin.url,
        pluginId: source.frameworkId,
        pin,
        stateKey,
      })
    );
  const artifacts = useMemo(
    () => artifactsState?.artifacts ?? [],
    [artifactsState?.artifacts]
  );
  const version = `${source.repo.ref ?? 'commit'}@${source.repo.commit.slice(0, 7)}`;
  const chip = sourceStatus?.ready
    ? 'Ready'
    : (sourceStatus?.reason ?? sourceStatus?.code ?? 'Pending');
  const artifactOptions = useMemo(
    () =>
      artifacts.filter(
        (item) =>
          item.contractName === source.contractName ||
          item.sourcePath === source.sourcePath
      ),
    [artifacts, source.contractName, source.sourcePath]
  );
  const chooseArtifact = (artifact: ArtifactLocation) => {
    const next = globalThis.structuredClone(document);
    const current = next.sources.find((item) => item.id === source.id);
    if (!current || current.origin === 'contract-type') return;
    current.artifactPath = artifact.artifactPath;
    delete current.artifactHash;
    onChange(next);
    setPickArtifact(false);
  };
  return (
    <article
      id={`workflow-source-${source.id}`}
      className={`card-milky p-5 scroll-mt-6 ${highlighted ? 'ring-2 ring-[var(--primary)] animate-pulse' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">
            {sanitizeDisplayText(source.contractName)}
          </h2>
          <div className="text-xs text-muted mono-data mt-1 truncate">
            {sanitizeDisplayText(canonicalGitUrl(source.repo.url))}
          </div>
          <div className="flex gap-2 mt-2 text-xs">
            <span className="pill rounded-full px-2 py-0.5 mono-data">
              {sanitizeDisplayText(version)}
            </span>
            <span
              className={`pill rounded-full px-2 py-0.5 ${sourceStatus?.ready ? 'pill-success' : 'pill-warning'}`}
            >
              {sanitizeDisplayText(chip)}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPickVersion(true)}
          >
            <Pencil size={14} /> Change version
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onRemove}
          >
            <Trash2 size={14} /> Remove
          </button>
        </div>
      </div>
      {artifactFailure && (
        <div className="mt-3 text-sm pill-warning rounded-md p-3 flex flex-wrap gap-3 items-center">
          <span>
            Artifact not found:{' '}
            {sanitizeDisplayText(
              artifactFailure.artifactPath ?? source.artifactPath
            )}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setPickArtifact(true);
              loadArtifacts();
            }}
          >
            Pick artifact
          </button>
        </div>
      )}
      {pickArtifact && (
        <div className="mt-3 card-milky p-3">
          <div className="flex justify-between text-sm">
            <span className="font-medium">Pinned artifacts</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={loadArtifacts}
            >
              Retry
            </button>
          </div>
          {artifactsState?.status === 'waiting' ? (
            <div className="mt-2 text-sm text-muted flex gap-2">
              <Loader2 className="animate-spin" size={15} />{' '}
              {artifactsState.waiting === 'pending'
                ? 'Build is still running…'
                : 'Version is busy…'}{' '}
              Retry when ready.
            </div>
          ) : null}
          {artifactsState?.status === 'error' ? (
            <div className="mt-2 text-sm text-err">{artifactsState.error}</div>
          ) : null}
          {artifactsState?.artifacts && (
            <div className="grid gap-2 mt-2">
              {(artifactOptions.length ? artifactOptions : artifacts).map(
                (artifact) => (
                  <button
                    type="button"
                    key={`${artifact.sourcePath}:${artifact.artifactPath}`}
                    className="btn btn-secondary justify-start mono-data"
                    onClick={() => chooseArtifact(artifact)}
                  >
                    {sanitizeDisplayText(artifact.artifactPath)}
                    {artifact.variant
                      ? ` · ${sanitizeDisplayText(Object.values(artifact.variant).filter(Boolean).join(' / '))}`
                      : ''}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}
      <DeployConfigPanel
        document={document}
        sourceId={source.id}
        plugins={plugins}
        onChange={onChange}
        onValidityChange={onStrategyValidityChange}
      />
      <AddVersionModal
        variant="pick"
        open={pickVersion}
        onOpenChange={setPickVersion}
        source={{
          sourceKey: source.id,
          label: sanitizeDisplayText(source.contractName),
          url: source.repo.url,
          local: false,
          initialCommit: source.repo.commit,
        }}
        onPick={(pin) =>
          onChange(changeSourceVersion(document, source.id, pin))
        }
      />
    </article>
  );
}
