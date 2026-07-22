import { useEffect, useMemo, useState } from 'react';
import type {
  ArtifactData,
  ArtifactLocation,
  ContractSource,
  ContractTypeInfo,
  ContractSourcePin,
  AddRepoVersionRequest,
  RepoVersionSummary,
} from '@ignite/api';
import Select from './Select';
import { useAppDispatch, useAppSelector } from '../store';
import {
  compilerScopeKey,
  listArtifacts,
  clearArtifactWait,
} from '../store/features/compiler/compilerSlice';
import { apiClient } from '../store/api/client';
import { contractSourceId } from '../utils/contractSourceId';
import {
  artifactVariantLabel,
  groupArtifactVariants,
  requiresExplicitVariantPick,
} from '../utils/artifactVariants';
import AddVersionModal, {
  type WorkspaceSwitchTarget,
} from '../routes/repositories/components/AddVersionModal';
import { repositoriesApi } from '../store/features/repositories/repositoriesApi';
import { setRepositoryInfo } from '../store/features/repositories/repositoriesSlice';
import { jobStarted } from '../store/features/jobs/jobsSlice';
import { wsSend } from '../store/middleware/websocket';
import OriginApprovalDialog from './OriginApprovalDialog';

export interface PickedArtifact {
  contract: ContractSource;
  abi: ArtifactData['abi'];
}

type RepoChoice = {
  value: string;
  label: string;
  path: string;
  pin?: ContractSourcePin;
  newVersion?: boolean;
  local?: boolean;
  workspace?: boolean;
};

export function pinForRepoVersion(
  version: RepoVersionSummary
): ContractSourcePin {
  return {
    url: version.url,
    commit: version.commit,
    ...(version.refLabel &&
    (version.refKind === 'tag' || version.refKind === 'branch')
      ? { ref: version.refLabel, refKind: version.refKind }
      : {}),
  };
}

export default function ArtifactPicker({
  value,
  onSelect,
}: {
  value?: ContractSource;
  onSelect: (contract: ContractSource, abi: ArtifactData['abi']) => void;
}) {
  const dispatch = useAppDispatch();
  const repositories = useAppSelector(
    (state) => state.repositories.repositories
  );
  const repositoryData = useAppSelector(
    (state) => state.repositories.repositoriesData
  );
  const compilations = useAppSelector((state) => state.compiler.compilations);
  const currentId = useAppSelector((state) => state.profiles.currentId);
  const [repoPath, setRepoPath] = useState(
    value?.origin === 'contract-type' ? '' : (value?.repoPathOrUrl ?? '')
  );
  const [pin, setPin] = useState<ContractSourcePin | undefined>(
    value?.origin === 'contract-type' ? undefined : value?.pin
  );
  const [frameworkId, setFrameworkId] = useState(
    value?.origin === 'contract-type' ? '' : (value?.frameworkId ?? '')
  );
  const [contractTypes, setContractTypes] = useState<ContractTypeInfo[]>([]);
  const [requiresGrant, setRequiresGrant] = useState<string[]>([]);
  const [contractTypeId, setContractTypeId] = useState(
    value?.origin === 'contract-type' ? value.pluginId : ''
  );
  const [versionSource, setVersionSource] = useState<{
    sourceKey: string;
    label: string;
    url?: string;
    repoPathOrUrl?: string;
    local: boolean;
  } | null>(null);
  const [addVersionOpen, setAddVersionOpen] = useState(false);
  const [originApproval, setOriginApproval] = useState<{
    origins: string[];
    request: AddRepoVersionRequest;
  } | null>(null);

  const repoChoices = useMemo(() => {
    const entries = [
      ...(repositories?.local ?? []),
      ...(repositories?.cloned ?? []),
    ];
    const attached = entries.flatMap<RepoChoice>((repo) => [
      {
        value: `live:${repo.pathOrUrl}`,
        label: repo.pathOrUrl,
        path: repo.pathOrUrl as string,
      },
      ...repo.versions.map((version) => ({
        value: `version:${repo.pathOrUrl}\u0000${version.commit}`,
        label: `  ↳ ${version.refLabel ?? version.commit.slice(0, 12)} · ${version.commit.slice(0, 12)}`,
        path: version.url,
        pin: pinForRepoVersion(version),
      })),
      {
        value: `new:${repo.pathOrUrl}`,
        label: `  + new version… (${repo.pathOrUrl})`,
        path: repo.pathOrUrl,
        newVersion: true,
        local: (repositories?.local ?? []).some(
          (local) => local.pathOrUrl === repo.pathOrUrl
        ),
        workspace: true,
      },
    ]);
    const orphaned = (repositories?.versionGroups ?? []).flatMap<RepoChoice>(
      (group) => [
        ...group.versions.map((version) => ({
          value: `version:${group.url}\u0000${version.commit}`,
          label: `  ↳ ${group.url} · ${version.refLabel ?? version.commit.slice(0, 12)} · ${version.commit.slice(0, 12)}`,
          path: group.url,
          pin: pinForRepoVersion(version),
        })),
        {
          value: `new:${group.url}`,
          label: `  + new version… (${group.url})`,
          path: group.url,
          newVersion: true,
          local: false,
        },
      ]
    );
    return [...attached, ...orphaned];
  }, [repositories]);
  const selectedChoice =
    repoChoices.find(
      (choice) => choice.path === repoPath && choice.pin?.commit === pin?.commit
    ) ??
    repoChoices.find(
      (choice) => choice.path === repoPath && !choice.pin && !choice.newVersion
    );
  const repoOptions = repoChoices.map(({ value, label }) => ({ value, label }));
  const frameworks = pin
    ? (
        repositories?.versionGroups
          .find((group) => group.url === pin.url)
          ?.versions.find((version) => version.commit === pin.commit)
          ?.frameworks ??
        [...(repositories?.local ?? []), ...(repositories?.cloned ?? [])]
          .flatMap((repo) => repo.versions)
          .find(
            (version) =>
              version.url === pin.url && version.commit === pin.commit
          )?.frameworks ??
        []
      ).map(({ id, name }) => ({ id, name }))
    : (repositoryData[repoPath]?.frameworks ?? []);
  const effectiveFramework = frameworkId || frameworks[0]?.id || '';
  const scopeKey = compilerScopeKey(repoPath, pin);
  const compilation = compilations[scopeKey]?.[effectiveFramework];
  const artifacts = compilation?.artifacts;
  const pinnedVersion = pin
    ? [
        ...(repositories?.local ?? []),
        ...(repositories?.cloned ?? []),
      ].flatMap((repo) => repo.versions).find(
        (version) => version.url === pin.url && version.commit === pin.commit
      ) ?? repositories?.versionGroups.find((group) => group.url === pin.url)
        ?.versions.find((version) => version.commit === pin.commit)
    : undefined;
  const lifecycleError = pin ? pinnedVersion?.lastError : repositoryData[repoPath]?.lastError;

  useEffect(() => {
    if (repoPath && effectiveFramework && artifacts === undefined && compilation?.status !== 'waiting')
      dispatch(
        listArtifacts({
          pathOrUrl: repoPath,
          pluginId: effectiveFramework,
          ...(pin ? { pin } : {}),
          stateKey: scopeKey,
        })
      );
    return () => {
      dispatch(clearArtifactWait({ repoPath: scopeKey, ...(effectiveFramework ? { frameworkId: effectiveFramework } : {}) }));
    };
  }, [artifacts, compilation?.status, dispatch, effectiveFramework, pin, repoPath, scopeKey]);
  useEffect(() => {
    let cancelled = false;
    void apiClient.request('listContractTypes', {}).then((response) => {
      if ('data' in response && !cancelled) {
        setContractTypes(response.data.contractTypes);
        setRequiresGrant(response.data.requiresGrant);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const groupedArtifacts = useMemo(
    () => groupArtifactVariants(artifacts ?? []),
    [artifacts]
  );

  const choose = async (artifact: ArtifactLocation) => {
    if (!repoPath || !effectiveFramework) return;
    const response = await apiClient.request('getArtifactData', {
      body: {
        pathOrUrl: repoPath,
        pluginId: effectiveFramework,
        artifactPath: artifact.artifactPath,
        ...(pin ? { pin } : {}),
      },
    });
    if (!('data' in response)) return;
    onSelect(
      {
        id: contractSourceId({
          repoPathOrUrl: repoPath,
          frameworkId: effectiveFramework,
          artifactPath: artifact.artifactPath,
          contractName: artifact.contractName,
          sourcePath: artifact.sourcePath,
          ...(pin ? { pin } : {}),
        }),
        repoPathOrUrl: repoPath,
        frameworkId: effectiveFramework,
        artifactPath: artifact.artifactPath,
        contractName: artifact.contractName,
        sourcePath: artifact.sourcePath,
        ...(pin ? { pin } : {}),
      },
      response.data.abi
    );
  };
  const chooseContractType = async (
    type: ContractTypeInfo,
    artifactKey: string
  ) => {
    const response = await apiClient.request('getContractTypeArtifact', {
      params: { pluginId: type.pluginId, artifactKey },
    });
    if (!('data' in response)) return;
    const identifier = response.data.artifact.sourceIdentifier;
    onSelect(
      {
        id:
          value?.origin === 'contract-type'
            ? value.id
            : `contract-type-${type.pluginId}-${artifactKey}`,
        origin: 'contract-type',
        pluginId: type.pluginId,
        artifactKey,
        versionLabel: type.versionLabel,
        contentHash: type.contentHash,
        contractName: identifier.split(':').at(-1) || artifactKey,
      },
      response.data.artifact.abi as ArtifactData['abi']
    );
  };
  const selectedType = contractTypes.find(
    (type) => type.pluginId === contractTypeId
  );
  const selectRepository = (next: string) => {
    const choice = repoChoices.find((candidate) => candidate.value === next);
    if (!choice) return;
    if (choice.newVersion) {
      setVersionSource({
        sourceKey: choice.path,
        label: choice.path,
        ...(choice.workspace ? { repoPathOrUrl: choice.path } : {}),
        ...(choice.local ? {} : { url: choice.path }),
        local: Boolean(choice.local),
      });
      setAddVersionOpen(true);
      return;
    }
    setRepoPath(choice.path);
    setPin(choice.pin);
    setFrameworkId('');
  };
  const addVersion = (request: AddRepoVersionRequest) => {
    if (currentId && versionSource)
      dispatch(
        repositoriesApi.addRepoVersion(
          currentId,
          request,
          (origins) => setOriginApproval({ origins, request })
        )
      );
    setAddVersionOpen(false);
  };
  const retryLifecycle = () => {
    if (repoPath) dispatch(repositoriesApi.checkRepos({ pathOrUrl: repoPath, force: true }));
  };

  return (
    <div className="grid gap-3">
      <Select
        options={repoOptions}
        value={selectedChoice?.value}
        placeholder="Select repository"
        onValueChange={selectRepository}
      />
      {frameworks.length > 1 && (
        <Select
          options={frameworks.map((item) => ({
            value: item.id,
            label: item.name,
          }))}
          value={effectiveFramework}
          placeholder="Select framework"
          onValueChange={setFrameworkId}
        />
      )}
      {artifacts === undefined && repoPath && (
        <p className="text-sm text-muted flex items-center gap-2"><span className="chip-dot pulse" />{compilation?.status === 'waiting' ? 'Compiling contracts…' : 'Loading contracts…'}</p>
      )}
      {lifecycleError && (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="chip chip-err">Compile failed</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={retryLifecycle}>Retry</button>
        </div>
      )}
      {groupedArtifacts.length > 0 && (
        <div className="glass-list">
          {groupedArtifacts.map((group) =>
            !requiresExplicitVariantPick(group) ? (
              <button
                key={`${group.sourcePath}:${group.contractName}`}
                type="button"
                className="list-row clickable text-left"
                onClick={() => void choose(group.artifacts[0])}
              >
                <div className="font-medium">{group.contractName}</div>
                <div className="mono-data text-muted">{group.sourcePath}</div>
              </button>
            ) : (
              <div
                key={`${group.sourcePath}:${group.contractName}`}
                className="list-row flex items-center gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{group.contractName}</div>
                  <div className="mono-data text-muted">{group.sourcePath}</div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.artifacts.map((artifact) => (
                    <button
                      key={artifact.artifactPath}
                      type="button"
                      className="chip chip-info"
                      onClick={() => void choose(artifact)}
                    >
                      {artifactVariantLabel(artifact)}
                    </button>
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      )}
      <section className="grid gap-2">
        <span className="eyebrow">Contract type</span>
        <Select
          options={contractTypes.map((type) => ({
            value: type.pluginId,
            label: `${type.label} (${type.versionLabel})`,
          }))}
          value={contractTypeId}
          requireSelection
          placeholder="Select contract type"
          onValueChange={setContractTypeId}
        />
        {selectedType && (
          <div className="glass-list">
            {selectedType.artifacts.map((artifactKey) => (
              <button
                key={artifactKey}
                type="button"
                className="list-row clickable text-left"
                onClick={() =>
                  void chooseContractType(selectedType, artifactKey)
                }
              >
                <div className="font-medium">{artifactKey}</div>
                <div className="mono-data text-muted">
                  {selectedType.pluginId}
                </div>
              </button>
            ))}
          </div>
        )}
        {requiresGrant.map((pluginId) => (
          <button
            key={pluginId}
            type="button"
            disabled
            className="input-glass text-sm text-muted opacity-60 text-left"
          >
            {pluginId} — grant contract bytecode access to select its artifacts.
          </button>
        ))}
      </section>
      <AddVersionModal
        open={addVersionOpen}
        onOpenChange={setAddVersionOpen}
        source={versionSource}
        onSubmit={addVersion}
        onSwitchWorkspace={async (path, target: WorkspaceSwitchTarget) => {
          const response = await apiClient.request(
            target.kind === 'branch' ? 'checkoutBranch' : 'checkoutCommit',
            {
              body:
                target.kind === 'branch'
                  ? { pathOrUrl: path, branch: target.branch }
                  : { pathOrUrl: path, commit: target.commit },
            }
          );
          if ('data' in response) {
            dispatch(
              jobStarted({
                jobId: response.data.jobId,
                type: 'repo.lifecycle',
                params: { pathOrUrl: path },
              })
            );
            dispatch(wsSend({ type: 'subscribe', jobId: response.data.jobId }));
          }
          dispatch(
            apiClient.dispatch.getRepoInfo({
              body: { pathOrUrl: path },
              onSuccess: (info) => setRepositoryInfo({ pathOrUrl: path, info }),
            })
          );
        }}
      />
      <OriginApprovalDialog
        origins={originApproval?.origins}
        onOpenChange={(open) => {
          if (!open) setOriginApproval(null);
        }}
        onApprove={() => {
          if (!originApproval || !currentId || !versionSource) return;
          dispatch(
            apiClient.dispatch.approveWorkflowOrigins({
              body: { origins: originApproval.origins },
              onSuccess: () => {
                dispatch(
                  repositoriesApi.addRepoVersion(
                    currentId,
                    originApproval.request,
                    (origins) =>
                      setOriginApproval({
                        origins,
                        request: originApproval.request,
                      })
                  )
                );
                setOriginApproval(null);
              },
            })
          );
        }}
      />
    </div>
  );
}
