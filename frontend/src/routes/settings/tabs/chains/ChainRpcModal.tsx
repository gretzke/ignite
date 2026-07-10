import * as Dialog from '@radix-ui/react-dialog';
import type { ChainInfo } from '@ignite/api';
import ChainRpcManager from '../../../../components/chains/ChainRpcManager';
import ChainIcon from './ChainIcon';

interface ChainRpcModalProps {
  chain: ChainInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ChainRpcModal({
  chain,
  open,
  onOpenChange,
}: ChainRpcModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{
            maxWidth: 640,
            width: '92vw',
            padding: 16,
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="flex items-center gap-3 mb-3 shrink-0">
            <ChainIcon chain={chain} />
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold truncate">
                RPC endpoints — {chain.name}
              </Dialog.Title>
              <div className="text-xs text-muted mono-data">
                chainId {chain.chainId}
              </div>
            </div>
          </div>

          <ChainRpcManager chainId={chain.chainId} />

          <div className="flex items-center justify-end pt-3 shrink-0">
            <Dialog.Close asChild>
              <button className="btn btn-secondary">Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
