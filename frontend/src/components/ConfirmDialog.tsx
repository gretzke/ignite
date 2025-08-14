import * as Dialog from '@radix-ui/react-dialog';
import React from 'react';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void | Promise<void>;
  confirmVariant?: 'primary' | 'secondary' | 'danger';
}

export default function ConfirmDialog({
  open,
  onOpenChange,
  title = 'Are you sure?',
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  confirmVariant = 'primary',
}: ConfirmDialogProps) {
  const confirmClass =
    confirmVariant === 'danger'
      ? 'btn btn-danger'
      : confirmVariant === 'secondary'
      ? 'btn btn-secondary'
      : 'btn btn-primary';

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
            maxWidth: 460,
            width: '90vw',
            padding: 16,
          }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            {title}
          </Dialog.Title>
          {description ? (
            <div className="text-sm opacity-80 mb-4">{description}</div>
          ) : null}
          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                {cancelLabel}
              </button>
            </Dialog.Close>
            <Dialog.Close asChild>
              <button
                type="button"
                className={confirmClass}
                onClick={() => {
                  void onConfirm();
                }}
              >
                {confirmLabel}
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
