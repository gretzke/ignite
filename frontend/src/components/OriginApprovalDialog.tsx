import ConfirmDialog from './ConfirmDialog';

export default function OriginApprovalDialog({
  origins,
  onOpenChange,
  onApprove,
}: {
  origins?: string[];
  onOpenChange: (open: boolean) => void;
  onApprove: () => void;
}) {
  return (
    <ConfirmDialog
      open={Boolean(origins?.length)}
      onOpenChange={onOpenChange}
      title="Approve pinned origins?"
      description={
        <>
          <p className="mb-2">
            This operation needs read access to these repository origins:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            {origins?.map((origin) => (
              <li key={origin} className="mono-data break-all">
                {origin}
              </li>
            ))}
          </ul>
        </>
      }
      confirmText="Approve and retry"
      variant="warning"
      onConfirm={onApprove}
    />
  );
}
