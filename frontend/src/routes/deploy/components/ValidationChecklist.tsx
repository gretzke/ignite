import type { ChainChecklist, ChainInfo } from '@ignite/api';
import { CheckCircle2, CircleAlert } from 'lucide-react';

const ITEM_KEYS = [
  'rpc',
  'signers',
  'args',
  'estimation',
  'balance',
  'inputs',
  'verification',
] as const;

interface ValidationChecklistProps {
  chains: Record<string, ChainChecklist>;
  chainInfo: ChainInfo[];
}

export default function ValidationChecklist({
  chains,
  chainInfo,
}: ValidationChecklistProps) {
  return (
    <div className="grid gap-3">
      {Object.entries(chains).map(([chainId, checklist]) => {
        const chain = chainInfo.find(
          (item) => String(item.chainId) === chainId
        );
        return (
          <section key={chainId} className="card-milky p-4">
            <h3 className="font-semibold mb-3">
              {chain?.name ?? `Chain ${chainId}`}
            </h3>
            <div className="glass-list">
              {ITEM_KEYS.map((key) => {
                const item = checklist[key];
                if (!item) return null;
                const failed = item.blocking && !item.ok;
                const warning = !item.blocking && !item.ok;
                return (
                  <div key={key} className="list-row flex items-start gap-3">
                    {failed ? (
                      <CircleAlert size={17} className="text-err mt-0.5" />
                    ) : warning ? (
                      <CircleAlert size={17} className="text-warn mt-0.5" />
                    ) : (
                      <CheckCircle2
                        size={17}
                        className={
                          item.ok ? 'text-ok mt-0.5' : 'text-warn mt-0.5'
                        }
                      />
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium capitalize">
                        {key}
                      </div>
                      <div
                        className="text-xs text-muted"
                        style={{ overflowWrap: 'anywhere' }}
                      >
                        {item.message}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
