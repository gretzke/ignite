import * as Dialog from '@radix-ui/react-dialog';
import { DirectoryPicker } from '../../../components/DirectoryPicker';
import { isValidUrl, isValidAbsolutePath } from '../../../utils/repo';

interface LocalRepoModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  onPathChange: (value: string) => void;
  onSubmit: () => void;
}

export function LocalRepoModal({
  open,
  onOpenChange,
  path,
  onPathChange,
  onSubmit,
}: LocalRepoModalProps) {
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
            maxWidth: 720,
            width: '90vw',
            padding: 16,
          }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            Add Local Repository
          </Dialog.Title>
          <div className="text-sm opacity-80 mb-4">
            Enter the full path or browse to your local repository directory.
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Repository Path
            </label>
            <DirectoryPicker
              value={path}
              onChange={onPathChange}
              onSubmit={onSubmit}
              autoFocus
            />
          </div>

          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSubmit}
              disabled={!path.trim() || !isValidAbsolutePath(path.trim())}
            >
              Add Repository
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface CloneRepoModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  urlError: string;
  onUrlChange: (value: string) => void;
  onSubmit: () => void;
}

export function CloneRepoModal({
  open,
  onOpenChange,
  url,
  urlError,
  onUrlChange,
  onSubmit,
}: CloneRepoModalProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && url.trim() && isValidUrl(url.trim())) {
      onSubmit();
    }
  };

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
            maxWidth: 460,
            width: '90vw',
            padding: 16,
          }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            Clone Repository
          </Dialog.Title>
          <div className="text-sm opacity-80 mb-4">
            Enter the URL of the repository you want to clone.
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Repository URL
            </label>
            <input
              type="url"
              placeholder="https://github.com/username/repository"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="input-glass"
              autoFocus
            />
            {urlError && (
              <div className="text-xs text-err mt-1">{urlError}</div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSubmit}
              disabled={!url.trim() || !isValidUrl(url.trim())}
            >
              Clone
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface CommitHashModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commitHash: string;
  commitHashError: string;
  onCommitHashChange: (value: string) => void;
  onSubmit: () => void;
}

export function CommitHashModal({
  open,
  onOpenChange,
  commitHash,
  commitHashError,
  onCommitHashChange,
  onSubmit,
}: CommitHashModalProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && commitHash.trim() && !commitHashError) {
      onSubmit();
    }
  };

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
            maxWidth: 460,
            width: '90vw',
            padding: 16,
          }}
        >
          <Dialog.Title className="text-lg font-medium mb-3">
            Checkout Commit
          </Dialog.Title>

          <div className="mb-3">
            <label htmlFor="commitHash" className="label inline-block mb-2">
              Commit Hash
            </label>
            <input
              id="commitHash"
              type="text"
              placeholder="Enter full or partial commit hash..."
              value={commitHash}
              onChange={(e) => onCommitHashChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="input-glass w-full"
              autoFocus
            />
            {commitHashError && (
              <div className="text-xs text-err mt-1">
                {commitHashError}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 mt-2">
            <Dialog.Close asChild>
              <button type="button" className="btn btn-secondary">
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onSubmit}
              disabled={!commitHash.trim() || !!commitHashError}
            >
              Checkout
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
