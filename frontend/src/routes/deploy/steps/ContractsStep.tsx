import { useEffect, useState } from 'react';
import { Box, Loader2, X } from 'lucide-react';
import type { DraftContract } from '../../../store/features/deployments/types';
import { apiClient } from '../../../store/api/client';

interface ContractsStepProps {
  contracts: DraftContract[];
  onRemove: (contractId: string) => void;
  onValidityChange: (valid: boolean) => void;
}

export default function ContractsStep({
  contracts,
  onRemove,
  onValidityChange,
}: ContractsStepProps) {
  const [checks, setChecks] = useState<
    Record<string, 'loading' | 'ok' | 'error'>
  >({});
  const [libraryNames, setLibraryNames] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    setChecks(
      Object.fromEntries(contracts.map((contract) => [contract.id, 'loading']))
    );
    for (const contract of contracts) {
      void apiClient
        .request('getArtifactData', {
          body: {
            pathOrUrl: contract.repoPathOrUrl,
            pluginId: contract.frameworkId,
            artifactPath: contract.artifactPath,
          },
        })
        .then((response) => {
          if (!('data' in response)) throw new Error(response.message);
          const names = Object.values(response.data.creationCodeLinkReferences ?? {}).flatMap(
            (source) => Object.keys(source as Record<string, unknown>)
          );
          if (!cancelled) {
            setChecks((current) => ({
              ...current,
              [contract.id]: 'ok',
            }));
            setLibraryNames((current) => ({ ...current, [contract.id]: names }));
          }
        })
        .catch(() => {
          if (!cancelled)
            setChecks((current) => ({
              ...current,
              [contract.id]: 'error',
            }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [contracts]);

  useEffect(() => {
    onValidityChange(
      contracts.length > 0 &&
        contracts.every((contract) => checks[contract.id] === 'ok')
    );
  }, [checks, contracts, onValidityChange]);

  return (
    <section className="grid gap-3">
      <div>
        <h2 className="text-lg font-semibold">Contracts</h2>
        <p className="text-sm text-muted">
          Add or remove the contracts included in this deployment. Execution
          order is configured in Steps.
        </p>
      </div>
      {contracts.length === 0 ? (
        <div className="card-milky p-8 text-center text-muted">
          Choose Deploy from a compiled contract or select artifacts in a
          repository.
        </div>
      ) : (
        <div className="glass-list">
          {contracts.map((contract) => (
            <div key={contract.id} className="list-row flex items-center gap-3">
              <Box size={17} className="text-info" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {contract.contractName}
                </div>
                <div className="mono-data text-muted truncate">
                  {contract.sourcePath} · {contract.frameworkId}
                </div>
                {checks[contract.id] === 'loading' && (
                  <div className="text-xs text-muted flex items-center gap-1">
                    <Loader2 size={12} className="animate-spin" /> Checking
                    deployability…
                  </div>
                )}
                {(libraryNames[contract.id] ?? []).length > 0 && (
                  <div className="text-xs text-muted">Uses libraries: {libraryNames[contract.id].join(', ')}</div>
                )}
                {checks[contract.id] === 'error' && (
                  <div className="text-xs text-err">
                    Artifact details could not be loaded.
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                aria-label={`Remove ${contract.contractName} from deployment`}
                title="Remove from deployment"
                onClick={() => onRemove(contract.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
