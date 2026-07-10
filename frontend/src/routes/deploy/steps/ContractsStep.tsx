import { ArrowDown, ArrowUp, Box } from 'lucide-react';
import type { DraftContract } from '../../../store/features/deployments/types';

interface ContractsStepProps {
  contracts: DraftContract[];
  onReorder: (fromIndex: number, toIndex: number) => void;
}

export default function ContractsStep({
  contracts,
  onReorder,
}: ContractsStepProps) {
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
