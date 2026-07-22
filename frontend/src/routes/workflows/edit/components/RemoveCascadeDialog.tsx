import * as Dialog from '@radix-ui/react-dialog';
import { sanitizeDisplayText, type ClearedWorkflowRef } from '@ignite/api';

export default function RemoveCascadeDialog({
  open,
  onOpenChange,
  removedStepIds,
  clearedRefs,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  removedStepIds: string[];
  clearedRefs: ClearedWorkflowRef[];
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content glass-overlay max-w-lg w-[92vw] p-5">
          <Dialog.Title className="text-lg font-semibold">
            Remove source?
          </Dialog.Title>
          <Dialog.Description className="text-sm text-muted mt-1">
            This change removes dependent deploy and call steps before it is
            applied.
          </Dialog.Description>
          <div className="mt-4 grid gap-3 text-sm">
            <div>
              <div className="font-medium">Removed steps</div>
              {removedStepIds.length ? (
                <ul className="mt-1 list-disc pl-5 mono-data">
                  {removedStepIds.map((id) => (
                    <li key={id}>{sanitizeDisplayText(id)}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-muted mt-1">No steps.</div>
              )}
            </div>
            <div>
              <div className="font-medium">Cleared references</div>
              {clearedRefs.length ? (
                <ul className="mt-1 list-disc pl-5 mono-data break-all">
                  {clearedRefs.map((ref) => (
                    <li key={`${ref.stepId}:${ref.path}`}>
                      {sanitizeDisplayText(ref.stepId)} ·{' '}
                      {sanitizeDisplayText(ref.path)}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-muted mt-1">No optional references.</div>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onConfirm}
            >
              Remove source
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
