import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void;
}

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  onConfirm,
}: ConfirmDialogProps) {
  const handleConfirm = () => {
    onConfirm();
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-surface"
          style={{
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            maxWidth: 420,
            width: '90vw',
            padding: 24,
          }}
        >
          <div className="flex items-start gap-4">
            <div
              className="size-10 rounded-full flex items-center justify-center shrink-0"
              style={{
                background:
                  variant === 'danger'
                    ? 'rgba(239, 68, 68, 0.1)'
                    : variant === 'warning'
                    ? 'rgba(245, 158, 11, 0.1)'
                    : 'rgba(59, 130, 246, 0.1)',
                color:
                  variant === 'danger'
                    ? '#ef4444'
                    : variant === 'warning'
                    ? '#f59e0b'
                    : '#3b82f6',
              }}
            >
              <AlertTriangle size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <Dialog.Title className="text-base font-semibold mb-2">
                {title}
              </Dialog.Title>
              <Dialog.Description className="text-sm opacity-80 mb-6">
                {description}
              </Dialog.Description>
              <div className="flex items-center justify-end gap-3">
                <Dialog.Close asChild>
                  <button type="button" className="btn btn-secondary">
                    {cancelText}
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  className={
                    variant === 'danger'
                      ? 'btn btn-danger'
                      : variant === 'warning'
                      ? 'btn btn-warning'
                      : 'btn btn-primary'
                  }
                  onClick={handleConfirm}
                >
                  {confirmText}
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
