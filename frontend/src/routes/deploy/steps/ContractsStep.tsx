import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Box, Loader2 } from 'lucide-react';
import type { DraftContract } from '../../../store/features/deployments/types';
import { apiClient } from '../../../store/api/client';

interface ContractsStepProps {
  contracts: DraftContract[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onValidityChange: (valid: boolean) => void;
}

export default function ContractsStep({
  contracts,
  onReorder,
  onValidityChange,
}: ContractsStepProps) {
  const [checks, setChecks] = useState<
    Record<string, 'loading' | 'ok' | 'linked' | 'error'>
  >({});

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
          const linked = Boolean(
            response.data.creationCodeLinkReferences &&
            Object.keys(response.data.creationCodeLinkReferences).length > 0
          );
          if (!cancelled)
            setChecks((current) => ({
              ...current,
              [contract.id]: linked ? 'linked' : 'ok',
            }));
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
          This order is used independently inside every chain lane.
        </p>
      </div>
      {contracts.length === 0 ? (
        <div className="card-milky p-8 text-center text-muted">
          Choose Deploy from a compiled contract or select artifacts in a
          repository.
        </div>
      ) : (
        <div className="glass-list">
          {contracts.map((contract, index) => (
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
                {checks[contract.id] === 'linked' && (
                  <div className="text-xs text-warn">
                    Requires library linking (planned for D5).
                  </div>
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
                disabled={index === 0}
                aria-label={`Move ${contract.contractName} up`}
                onClick={() => onReorder(index, index - 1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={index === contracts.length - 1}
                aria-label={`Move ${contract.contractName} down`}
                onClick={() => onReorder(index, index + 1)}
              >
                <ArrowDown size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
