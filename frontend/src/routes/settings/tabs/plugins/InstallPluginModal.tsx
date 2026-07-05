import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppDispatch } from '../../../../store';
import { pluginsApi } from '../../../../store/features/plugins/pluginsSlice';
import { DirectoryPicker } from '../../../../components/DirectoryPicker';

const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

const isValidAbsolutePath = (path: string): boolean => {
  const trimmedPath = path.trim();
  return (
    trimmedPath.startsWith('/') || // Unix/macOS absolute path
    /^[A-Za-z]:[\\]/.test(trimmedPath) // Windows absolute path (C:\, D:\, etc.)
  );
};

interface InstallModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InstallFromGitModal({ open, onOpenChange }: InstallModalProps) {
  const dispatch = useAppDispatch();
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [urlError, setUrlError] = useState('');

  const canSubmit = url.trim() !== '' && isValidUrl(url.trim());

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen);
    if (!isOpen) {
      setUrl('');
      setRef('');
      setUrlError('');
    }
  };

  const handleUrlChange = (value: string) => {
    setUrl(value);
    if (value.trim() && !isValidUrl(value.trim())) {
      setUrlError(
        'Please enter a valid URL (e.g., https://github.com/user/plugin)'
      );
    } else {
      setUrlError('');
    }
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    dispatch(pluginsApi.installGit(url.trim(), ref.trim() || undefined));
    handleOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-surface"
          style={{ maxWidth: 460, width: '90vw', padding: 16 }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            Install Plugin from GitHub
          </Dialog.Title>
          <div className="text-sm opacity-80 mb-4">
            Enter the URL of the plugin repository. The plugin is built in an
            isolated environment before it is installed.
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Repository URL
            </label>
            <input
              type="url"
              placeholder="https://github.com/username/plugin"
              value={url}
              onChange={(e) => handleUrlChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
              className="input-glass"
              autoFocus
            />
            {urlError && (
              <div className="text-xs text-red-400 mt-1">{urlError}</div>
            )}
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Branch, Tag or Commit{' '}
              <span className="opacity-60 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="main"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
              }}
              className="input-glass"
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
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              Install
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function InstallFromPathModal({
  open,
  onOpenChange,
}: InstallModalProps) {
  const dispatch = useAppDispatch();
  const [path, setPath] = useState('');

  const canSubmit = path.trim() !== '' && isValidAbsolutePath(path.trim());

  const handleOpenChange = (isOpen: boolean) => {
    onOpenChange(isOpen);
    if (!isOpen) setPath('');
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    dispatch(pluginsApi.install(path.trim()));
    handleOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="dialog-overlay"
          style={{ background: 'transparent' }}
        />
        <Dialog.Content
          className="dialog-content glass-surface"
          style={{ maxWidth: 720, width: '90vw', padding: 16 }}
        >
          <Dialog.Title className="text-base font-semibold mb-2">
            Install Plugin from Local Path
          </Dialog.Title>
          <div className="text-sm opacity-80 mb-4">
            Select the plugin directory to build and install. This option is
            only available in development mode.
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              Plugin Path
            </label>
            <DirectoryPicker
              value={path}
              onChange={setPath}
              onSubmit={handleSubmit}
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
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              Install
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
