import { useEffect, useMemo, useState } from 'react';
import type { ArtifactData, ArtifactLocation, ContractSource, ContractTypeInfo } from '@ignite/api';
import Select from './Select';
import { useAppDispatch, useAppSelector } from '../store';
import { listArtifacts } from '../store/features/compiler/compilerSlice';
import { apiClient } from '../store/api/client';
import { contractSourceId } from '../utils/contractSourceId';

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
  const [repoPath, setRepoPath] = useState(value?.origin === 'contract-type' ? '' : value?.repoPathOrUrl ?? '');
  const [frameworkId, setFrameworkId] = useState(value?.origin === 'contract-type' ? '' : value?.frameworkId ?? '');
  const [contractTypes, setContractTypes] = useState<ContractTypeInfo[]>([]);
  const [requiresGrant, setRequiresGrant] = useState<string[]>([]);
  const [contractTypeId, setContractTypeId] = useState(value?.origin === 'contract-type' ? value.pluginId : '');

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
  useEffect(() => {
    let cancelled = false;
    void apiClient.request('listContractTypes', {}).then((response) => {
      if ('data' in response && !cancelled) {
        setContractTypes(response.data.contractTypes);
        setRequiresGrant(response.data.requiresGrant);
      }
    });
    return () => { cancelled = true; };
  }, []);

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
        id: contractSourceId({
          repoPathOrUrl: repoPath,
          frameworkId: effectiveFramework,
          artifactPath: artifact.artifactPath,
          contractName: artifact.contractName,
          sourcePath: artifact.sourcePath,
        }),
        repoPathOrUrl: repoPath,
        frameworkId: effectiveFramework,
        artifactPath: artifact.artifactPath,
        contractName: artifact.contractName,
        sourcePath: artifact.sourcePath,
      },
      response.data.abi
    );
  };
  const chooseContractType = async (type: ContractTypeInfo, artifactKey: string) => {
    const response = await apiClient.request('getContractTypeArtifact', {
      params: { pluginId: type.pluginId, artifactKey },
    });
    if (!('data' in response)) return;
    const identifier = response.data.artifact.sourceIdentifier;
    onSelect({
      id: value?.origin === 'contract-type' ? value.id : `contract-type-${type.pluginId}-${artifactKey}`,
      origin: 'contract-type',
      pluginId: type.pluginId,
      artifactKey,
      versionLabel: type.versionLabel,
      contentHash: type.contentHash,
      contractName: identifier.split(':').at(-1) || artifactKey,
    }, response.data.artifact.abi as ArtifactData['abi']);
  };
  const selectedType = contractTypes.find((type) => type.pluginId === contractTypeId);

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
      <section className="grid gap-2">
        <span className="eyebrow">Contract type</span>
        <Select options={contractTypes.map((type) => ({ value: type.pluginId, label: `${type.label} (${type.versionLabel})` }))} value={contractTypeId} requireSelection placeholder="Select contract type" onValueChange={setContractTypeId} />
        {selectedType && <div className="glass-list">
          {selectedType.artifacts.map((artifactKey) => <button key={artifactKey} type="button" className="list-row clickable text-left" onClick={() => void chooseContractType(selectedType, artifactKey)}>
            <div className="font-medium">{artifactKey}</div>
            <div className="mono-data text-muted">{selectedType.pluginId}</div>
          </button>)}
        </div>}
        {requiresGrant.map((pluginId) => <button key={pluginId} type="button" disabled className="input-glass text-sm text-muted opacity-60 text-left">{pluginId} — grant contract bytecode access to select its artifacts.</button>)}
      </section>
    </div>
  );
}
