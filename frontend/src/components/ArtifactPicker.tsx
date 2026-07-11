import { useEffect, useMemo, useState } from 'react';
import type { ArtifactData, ArtifactLocation, ContractSource } from '@ignite/api';
import Select from './Select';
import { useAppDispatch, useAppSelector } from '../store';
import { listArtifacts } from '../store/features/compiler/compilerSlice';
import { apiClient } from '../store/api/client';

export interface PickedArtifact {
  contract: ContractSource;
  abi: ArtifactData['abi'];
}

export default function ArtifactPicker({
  value,
  onSelect,
}: {
  value?: ContractSource;
  onSelect: (contract: ContractSource, abi: ArtifactData['abi']) => void;
}) {
  const dispatch = useAppDispatch();
  const repositories = useAppSelector((state) => state.repositories.repositories);
  const repositoryData = useAppSelector((state) => state.repositories.repositoriesData);
  const compilations = useAppSelector((state) => state.compiler.compilations);
  const [repoPath, setRepoPath] = useState(value?.repoPathOrUrl ?? '');
  const [frameworkId, setFrameworkId] = useState(value?.frameworkId ?? '');

  const repoOptions = useMemo(
    () =>
      [
        ...(repositories?.local ?? []),
        ...(repositories?.cloned ?? []),
      ].map((repo) => ({ value: repo.pathOrUrl, label: repo.pathOrUrl })),
    [repositories]
  );
  const frameworks = repositoryData[repoPath]?.frameworks ?? [];
  const effectiveFramework = frameworkId || frameworks[0]?.id || '';
  const artifacts = compilations[repoPath]?.[effectiveFramework]?.artifacts;

  useEffect(() => {
    if (repoPath && effectiveFramework && artifacts === undefined)
      dispatch(listArtifacts({ pathOrUrl: repoPath, pluginId: effectiveFramework }));
  }, [artifacts, dispatch, effectiveFramework, repoPath]);

  const deduped = useMemo(() => {
    const byIdentity = new Map<string, ArtifactLocation>();
    for (const artifact of artifacts ?? [])
      byIdentity.set(`${artifact.sourcePath}:${artifact.contractName}`, artifact);
    return [...byIdentity.values()];
  }, [artifacts]);

  const choose = async (artifact: ArtifactLocation) => {
    if (!repoPath || !effectiveFramework) return;
    const response = await apiClient.request('getArtifactData', {
      body: { pathOrUrl: repoPath, pluginId: effectiveFramework, artifactPath: artifact.artifactPath },
    });
    if (!('data' in response)) return;
    onSelect(
      {
        id: `${effectiveFramework}:${artifact.artifactPath}:${artifact.contractName}`,
        repoPathOrUrl: repoPath,
        frameworkId: effectiveFramework,
        artifactPath: artifact.artifactPath,
        contractName: artifact.contractName,
        sourcePath: artifact.sourcePath,
      },
      response.data.abi
    );
  };

  return (
    <div className="grid gap-3">
      <Select options={repoOptions} value={repoPath} placeholder="Select repository" onValueChange={(next) => { setRepoPath(next); setFrameworkId(''); }} />
      {frameworks.length > 1 && <Select options={frameworks.map((item) => ({ value: item.id, label: item.name }))} value={effectiveFramework} placeholder="Select framework" onValueChange={setFrameworkId} />}
      {artifacts === undefined && repoPath && <p className="text-sm text-muted">Loading contracts…</p>}
      {deduped.length > 0 && <div className="glass-list">
        {deduped.map((artifact) => <button key={`${artifact.sourcePath}:${artifact.contractName}`} type="button" className="list-row clickable text-left" onClick={() => void choose(artifact)}>
          <div className="font-medium">{artifact.contractName}</div>
          <div className="mono-data text-muted">{artifact.sourcePath}</div>
        </button>)}
      </div>}
    </div>
  );
}
