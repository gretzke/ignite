import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import type { WorkflowInstallDiff, WorkflowSourceDetail } from '@ignite/api';
import { sanitizeDisplayText } from '@ignite/api';

interface UpdateDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diff: WorkflowInstallDiff;
  onConfirm: () => void;
}

function sourceLabel(detail: WorkflowSourceDetail): string {
  const pin = detail.commit
    ? `${detail.ref ? `${detail.ref}@` : ''}${detail.commit}`
    : undefined;
  return [
    detail.id,
    detail.canonicalUrl ?? detail.url,
    pin,
    detail.artifactPath,
  ]
    .filter(Boolean)
    .map((value) => sanitizeDisplayText(value!))
    .join(' · ');
}

function DiffRow({ children }: { children: ReactNode }) {
  return <div className="text-sm break-words">{children}</div>;
}

export function UpdateDiffRows({ diff }: { diff: WorkflowInstallDiff }) {
  const hasChanges =
    diff.sourcesAdded.length +
      diff.sourcesRemoved.length +
      diff.sourcesRenamed.length +
      diff.versionsChanged.length +
      diff.artifactsChanged.length +
      diff.sourcesModified.length +
      diff.pluginsChanged.length >
      0 ||
    diff.stepsChanged ||
    diff.hooksChanged ||
    diff.formattingOnly;

  return (
    <>
      {!hasChanges && <DiffRow>No installation changes detected.</DiffRow>}
      {diff.sourcesAdded.map((detail) => (
        <DiffRow key={`added-${detail.id}`}>
          Source added: <span className="mono-data">{sourceLabel(detail)}</span>
        </DiffRow>
      ))}
      {diff.sourcesRemoved.map((detail) => (
        <DiffRow key={`removed-${detail.id}`}>
          Source removed:{' '}
          <span className="mono-data">{sourceLabel(detail)}</span>
        </DiffRow>
      ))}
      {diff.sourcesRenamed.map(({ from, to, detail }) => (
        <DiffRow key={`renamed-${from}-${to}`}>
          Source renamed:{' '}
          <span className="mono-data">{sanitizeDisplayText(from)}</span>
          {' → '}
          <span className="mono-data">{sanitizeDisplayText(to)}</span>
          {' · '}
          {sourceLabel(detail)}
        </DiffRow>
      ))}
      {diff.versionsChanged.map(({ detail, from, to }) => (
        <DiffRow key={`version-${detail.id}`}>
          Version changed:{' '}
          <span className="mono-data">{sanitizeDisplayText(detail.id)}</span>
          {' · '}
          <span className="mono-data">
            {sanitizeDisplayText(
              `${from.ref ? `${from.ref}@` : ''}${from.commit}`
            )}
          </span>
          {' → '}
          <span className="mono-data">
            {sanitizeDisplayText(`${to.ref ? `${to.ref}@` : ''}${to.commit}`)}
          </span>
        </DiffRow>
      ))}
      {diff.artifactsChanged.map(({ detail, from, to }) => (
        <DiffRow key={`artifact-${detail.id}`}>
          Artifact changed:{' '}
          <span className="mono-data">{sanitizeDisplayText(detail.id)}</span>
          {' · '}
          <span className="mono-data">{sanitizeDisplayText(from)}</span>
          {' → '}
          <span className="mono-data">{sanitizeDisplayText(to)}</span>
        </DiffRow>
      ))}
      {diff.sourcesModified.map(({ detail, changes }) => (
        <DiffRow key={`modified-${detail.id}`}>
          Source modified:{' '}
          <span className="mono-data">{sanitizeDisplayText(detail.id)}</span>
          {' · fields: '}
          {changes.map((change) => sanitizeDisplayText(change)).join(', ')}
        </DiffRow>
      ))}
      {diff.pluginsChanged.map(({ id, kind, from, to }) => (
        <DiffRow key={`plugin-${id}-${kind}`}>
          Plugin {sanitizeDisplayText(kind)}:{' '}
          <span className="mono-data">{sanitizeDisplayText(id)}</span>
          {from && ` · ${sanitizeDisplayText(from)}`}
          {to && ` → ${sanitizeDisplayText(to)}`}
        </DiffRow>
      ))}
      {diff.stepsChanged && <DiffRow>Deployment steps changed.</DiffRow>}
      {diff.hooksChanged && <DiffRow>Workflow hooks changed.</DiffRow>}
      {diff.formattingOnly && (
        <DiffRow>Formatting-only document change.</DiffRow>
      )}
    </>
  );
}

export default function UpdateDiffDialog({
  open,
  onOpenChange,
  diff,
  onConfirm,
}: UpdateDiffDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-overlay"
          style={{ maxWidth: 720, width: '90vw', padding: 16 }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            Update workflow installation
          </Dialog.Title>
          <div className="text-sm opacity-80 mb-4">
            Review the changes that will be installed from this workflow file.
          </div>
          <div className="space-y-2 max-h-[55vh] overflow-y-auto">
            <UpdateDiffRows diff={diff} />
          </div>
          <div className="flex items-center justify-end gap-2 mt-4">
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
              Update
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
